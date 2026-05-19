import type { API, Logger } from 'homebridge';
import type { MatterAccessory } from 'homebridge';
import type { KseniaDevice, KseniaThermostat } from '../types';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings';
import type { KseniaWebSocketClient } from '../websocket-client';
import { deviceToMatterAccessory } from './matter-device-mapper';
import { buildStateUpdates, type PendingMatterStateUpdate } from './matter-state-updates';
import {
    handleMissingRegisteredAccessory,
    isMatterAccessoryQueryable,
    registerFallbackAccessory,
    type MatterRegistration,
} from './matter-registration-recovery';
import { MatterStateUpdateQueue } from './matter-state-update-queue';

// ---------------------------------------------------------------------------
// Configuration knobs
// ---------------------------------------------------------------------------

/**
 * Time to wait between calling `api.matter.registerPlatformAccessories(...)` and
 * trusting that the accessory is queryable via `api.matter.updateAccessoryState(...)`.
 * HB2's register API is fire-and-forget (it just emits an internal event); state
 * updates received in this window are buffered.
 */
const MATTER_REGISTER_SETTLE_MS = 2000;

/**
 * Whether to fall back to a Matter TemperatureSensor when registering a real
 * Thermostat fails (typically due to matter.js 0.17 `presetTypes` validation).
 * HAP continues to expose the full Thermostat regardless.
 */
const MATTER_THERMOSTAT_FALLBACK_TO_TEMPERATURE_SENSOR = true;

// ---------------------------------------------------------------------------
// Registration state machine
// ---------------------------------------------------------------------------

export type MatterRegistrationStatus = 'pending' | 'registered' | 'failed' | 'skipped';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class MatterAccessoryRegistry {
    /** UUIDs that HB2 reported to us via `configureMatterAccessory` (cache restore). */
    private readonly cachedUUIDs: Set<string> = new Set();
    /** Full registration state, keyed by Lares device id (also the Matter UUID). */
    private readonly registrations: Map<string, MatterRegistration> = new Map();
    private readonly stateUpdateQueue: MatterStateUpdateQueue;
    /** UUIDs we've seen in the current discovery cycle — used to prune stale ones. */
    private activeDiscoveredUUIDs: Set<string> = new Set();
    /** UUIDs that fell back to TemperatureSensor — drive the alternate state-push path. */
    private readonly thermostatFallbackUUIDs: Set<string> = new Set();

    constructor(
        private readonly api: API,
        private readonly log: Logger,
        private readonly getWsClient: () => KseniaWebSocketClient | undefined,
    ) {
        this.stateUpdateQueue = new MatterStateUpdateQueue(
            this.api,
            this.log,
            this.registrations,
            (err) => this.fmtErr(err),
        );
    }

    public get isEnabled(): boolean {
        return !!this.api.matter;
    }

    // -----------------------------------------------------------------------
    // Lifecycle hooks called by Platform
    // -----------------------------------------------------------------------

    public configureCachedAccessory(accessory: MatterAccessory): void {
        this.cachedUUIDs.add(accessory.UUID);
        this.log.debug(`[Matter] Cached accessory: ${accessory.displayName} (${accessory.UUID})`);
    }

    public startDiscoveryCycle(): void {
        this.activeDiscoveredUUIDs = new Set();
    }

    public async addOrUpdateAccessory(device: KseniaDevice): Promise<void> {
        if (!this.api.matter) return;
        this.activeDiscoveredUUIDs.add(device.id);

        const existing = this.registrations.get(device.id);
        if (existing) {
            // Already known — either still pending the settle window, registered, failed or skipped.
            switch (existing.status) {
                case 'pending':
                    // Queue the latest state; the settle handler will flush it.
                    this.enqueueStateFor(device);
                    return;
                case 'registered':
                    await this.refreshAccessoryMetadata(device, existing);
                    await this.pushStateUpdate(device);
                    return;
                case 'failed':
                case 'skipped':
                    return; // silent, we've already logged once
            }
        }

        await this.registerAccessory(device);
    }

    public async updateAccessoryState(device: KseniaDevice): Promise<void> {
        if (!this.api.matter) return;
        const existing = this.registrations.get(device.id);

        if (!existing) {
            // First time we see this device — register it (lazy path for HAP-cached devices
            // whose WS "discovered" callback hasn't fired yet).
            await this.registerAccessory(device);
            return;
        }

        switch (existing.status) {
            case 'pending':
                this.enqueueStateFor(device);
                return;
            case 'registered':
                await this.pushStateUpdate(device);
                return;
            case 'failed':
            case 'skipped':
                return;
        }
    }

    public async pruneStaleAccessories(): Promise<void> {
        if (!this.api.matter) return;
        for (const [uuid, reg] of this.registrations) {
            if (reg.status !== 'registered') continue;
            if (this.activeDiscoveredUUIDs.has(uuid)) continue;
            this.log.info(`[Matter] Removing stale accessory: ${reg.displayName} (${uuid})`);
            try {
                await this.api.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
                    { UUID: uuid } as MatterAccessory,
                ]);
                this.registrations.delete(uuid);
                this.cachedUUIDs.delete(uuid);
                this.thermostatFallbackUUIDs.delete(uuid);
            } catch (err) {
                this.log.warn(`[Matter] Failed to unregister ${uuid}: ${this.fmtErr(err)}`);
            }
        }
    }

    /** Test-only introspection: registration status for a given device id. */
    public getStatus(uuid: string): MatterRegistrationStatus | undefined {
        return this.registrations.get(uuid)?.status;
    }

    /** Test-only introspection: queued updates count for a device id. */
    public getPendingCount(uuid: string): number {
        return this.registrations.get(uuid)?.pendingStateUpdates.length ?? 0;
    }

    // -----------------------------------------------------------------------
    // Registration internals
    // -----------------------------------------------------------------------

    private async registerAccessory(device: KseniaDevice): Promise<void> {
        const matterAccessory = deviceToMatterAccessory(device, {
            api: this.api,
            log: this.log,
            getWsClient: this.getWsClient,
        });
        if (!matterAccessory) return;

        const reg: MatterRegistration = {
            uuid: device.id,
            displayName: device.name,
            deviceType: device.type,
            matterAccessory,
            status: 'pending',
            recoveryAttempts: 0,
            pendingStateUpdates: [],
        };
        this.registrations.set(device.id, reg);

        const fromCache = this.cachedUUIDs.has(device.id);
        this.log.info(`[Matter] register requested: ${device.name} (${device.type})${fromCache ? ' [cache restore]' : ''}`);

        try {
            await this.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [matterAccessory]);
        } catch (err) {
            await this.handleRegisterFailure(device, err);
            return;
        }

        this.log.debug(`[Matter] settle started (${MATTER_REGISTER_SETTLE_MS}ms): ${device.name}`);
        // Don't `await` the settle timer — let the WS event loop continue. Queued updates
        // are stored on the registration; we flush them when the timer fires.
        this.scheduleComplete(device.id);
    }

    private async completeRegistration(uuid: string): Promise<void> {
        const reg = this.registrations.get(uuid);
        if (!reg || reg.status !== 'pending') return;

        if (!await isMatterAccessoryQueryable(this.api, this.log, (err) => this.fmtErr(err), reg)) {
            await handleMissingRegisteredAccessory(reg, this.recoveryDeps());
            return;
        }

        reg.status = 'registered';
        reg.registeredAt = Date.now();
        this.stateUpdateQueue.markReadyAfterBootstrap(reg);
        this.log.info(`[Matter] registered: ${reg.displayName}`);
        await this.updateCachedAccessoryMetadata(reg);

        this.stateUpdateQueue.scheduleFlush(uuid);
    }

    /**
     * Centralised handler for failed initial registration. Currently only used for thermostats —
     * other device types are simply marked failed and skipped for the session.
     */
    private async handleRegisterFailure(device: KseniaDevice, err: unknown): Promise<void> {
        const reg = this.registrations.get(device.id)!;
        const msg = this.fmtErr(err);

        if (device.type === 'thermostat' && MATTER_THERMOSTAT_FALLBACK_TO_TEMPERATURE_SENSOR) {
            this.log.warn(
                `Matter Thermostat registration failed for ${device.name}; falling back to TemperatureSensor `
                + `due to matter.js thermostat presetTypes validation issue. Error: ${msg}`,
            );
            try {
                await registerFallbackAccessory(device as KseniaThermostat, reg, this.recoveryDeps());
                return;
            } catch (fbErr) {
                this.log.warn(`[Matter] Fallback TemperatureSensor also failed for ${device.name}: ${this.fmtErr(fbErr)}`);
            }
        }

        reg.status = 'failed';
        reg.failedAt = Date.now();
        reg.lastError = msg;
        reg.pendingStateUpdates = [];
        this.log.warn(`[Matter] accessory failed: ${device.name} — ${msg}`);
    }

    // -----------------------------------------------------------------------
    // State propagation
    // -----------------------------------------------------------------------

    private async pushStateUpdate(device: KseniaDevice): Promise<void> {
        const reg = this.registrations.get(device.id);
        if (!reg) return;

        const updates = this.buildUpdatesFor(device);
        for (const u of updates) {
            await this.stateUpdateQueue.pushOrQueue(reg, u);
        }
    }

    private enqueueStateFor(device: KseniaDevice): void {
        const reg = this.registrations.get(device.id);
        if (!reg) return;
        reg.matterAccessory.context.device = device;
        for (const u of this.buildUpdatesFor(device)) {
            // Dedupe by (clusterName, partId) — keep only the latest payload per slot.
            const idx = reg.pendingStateUpdates.findIndex(
                (p) => p.clusterName === u.clusterName && p.partId === u.partId,
            );
            if (idx >= 0) reg.pendingStateUpdates[idx] = u;
            else reg.pendingStateUpdates.push(u);
        }
        this.log.debug(`[Matter] update queued: ${device.name} (pending=${reg.pendingStateUpdates.length})`);
    }

    private async refreshAccessoryMetadata(device: KseniaDevice, reg: MatterRegistration): Promise<void> {
        const matterAccessory = deviceToMatterAccessory(device, {
            api: this.api,
            log: this.log,
            getWsClient: this.getWsClient,
        });
        if (!matterAccessory) return;

        if (!this.hasMetadataChanged(reg.matterAccessory, matterAccessory)) return;

        reg.matterAccessory = matterAccessory;
        reg.displayName = matterAccessory.displayName;
        await this.updateCachedAccessoryMetadata(reg);
    }

    private hasMetadataChanged(previous: MatterAccessory, next: MatterAccessory): boolean {
        return previous.displayName !== next.displayName
            || previous.manufacturer !== next.manufacturer
            || previous.model !== next.model
            || previous.serialNumber !== next.serialNumber
            || previous.firmwareRevision !== next.firmwareRevision;
    }

    private async updateCachedAccessoryMetadata(reg: MatterRegistration): Promise<void> {
        try {
            await this.api.matter!.updatePlatformAccessories([reg.matterAccessory]);
            this.log.debug(`[Matter] metadata cache refreshed: ${reg.displayName}`);
        } catch (err) {
            this.log.debug(`[Matter] metadata cache refresh failed for ${reg.displayName}: ${this.fmtErr(err)}`);
        }
    }

    private buildUpdatesFor(device: KseniaDevice): PendingMatterStateUpdate[] {
        const isFallback = device.type === 'thermostat' && this.thermostatFallbackUUIDs.has(device.id);
        return buildStateUpdates(device, isFallback);
    }

    private fmtErr(err: unknown): string {
        return err instanceof Error ? err.message : String(err);
    }

    private scheduleComplete(uuid: string): void {
        setTimeout(() => { void this.completeRegistration(uuid); }, MATTER_REGISTER_SETTLE_MS);
    }

    private recoveryDeps(): Parameters<typeof handleMissingRegisteredAccessory>[1] {
        return {
            api: this.api,
            log: this.log,
            thermostatFallbackUUIDs: this.thermostatFallbackUUIDs,
            getWsClient: this.getWsClient,
            scheduleComplete: (uuid) => this.scheduleComplete(uuid),
            fmtErr: (err) => this.fmtErr(err),
            settleMs: MATTER_REGISTER_SETTLE_MS,
            thermostatFallbackEnabled: MATTER_THERMOSTAT_FALLBACK_TO_TEMPERATURE_SENSOR,
        };
    }
}
