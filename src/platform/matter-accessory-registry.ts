import type { API, Logger } from 'homebridge';
import type { MatterAccessory } from 'homebridge';
import type { KseniaDevice, KseniaThermostat } from '../types';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings';
import type { KseniaWebSocketClient } from '../websocket-client';
import { deviceToMatterAccessory, mapThermostatAsTemperatureSensor } from './matter-device-mapper';
import { buildStateUpdates } from './matter-state-updates';
import {
    handleMissingRegisteredAccessory,
    registerFallbackAccessory,
    type MatterRegistration,
} from './matter-registration-recovery';
import { MatterStateUpdateQueue } from './matter-state-update-queue';
import { MatterFallbackStore } from './matter-fallback-store';
import { probeUntilQueryable } from './matter-register-probe';

/**
 * Whether to fall back to a Matter TemperatureSensor when registering a real
 * Thermostat fails (typically due to matter.js 0.17 `presetTypes` validation).
 */
const MATTER_THERMOSTAT_FALLBACK_TO_TEMPERATURE_SENSOR = true;

export type MatterRegistrationStatus = 'pending' | 'registered' | 'failed' | 'skipped';

export interface MatterRegistryDeps {
    api: API;
    log: Logger;
    getWsClient: () => KseniaWebSocketClient | undefined;
    storagePath: string;
    momentaryAutoOffMs?: number;
}

export class MatterAccessoryRegistry {
    private readonly api: API;
    private readonly log: Logger;
    private readonly getWsClient: () => KseniaWebSocketClient | undefined;
    private readonly momentaryAutoOffMs?: number;
    private readonly cachedUUIDs: Set<string> = new Set();
    private readonly registrations: Map<string, MatterRegistration> = new Map();
    private readonly stateUpdateQueue: MatterStateUpdateQueue;
    private activeDiscoveredUUIDs: Set<string> = new Set();
    private readonly thermostatFallbackUUIDs: Set<string> = new Set();
    private readonly fallbackStore: MatterFallbackStore;

    constructor(deps: MatterRegistryDeps) {
        this.api = deps.api;
        this.log = deps.log;
        this.getWsClient = deps.getWsClient;
        this.momentaryAutoOffMs = deps.momentaryAutoOffMs;
        this.fallbackStore = new MatterFallbackStore(deps.storagePath, deps.log);
        for (const uuid of this.fallbackStore.load()) this.thermostatFallbackUUIDs.add(uuid);

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
            switch (existing.status) {
                case 'pending':
                    this.enqueueStateFor(device);
                    return;
                case 'registered':
                    await this.refreshAccessoryMetadata(device, existing);
                    this.enqueueStateFor(device);
                    this.stateUpdateQueue.scheduleFlush(device.id);
                    return;
                case 'failed':
                case 'skipped':
                    return;
            }
        }

        await this.registerAccessory(device);
    }

    public async updateAccessoryState(device: KseniaDevice): Promise<void> {
        if (!this.api.matter) return;
        const existing = this.registrations.get(device.id);
        if (!existing) {
            await this.registerAccessory(device);
            return;
        }
        if (existing.status === 'failed' || existing.status === 'skipped') return;
        this.enqueueStateFor(device);
        this.stateUpdateQueue.scheduleFlush(device.id);
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
                this.fallbackStore.remove(uuid);
            } catch (err) {
                this.log.warn(`[Matter] Failed to unregister ${uuid}: ${this.fmtErr(err)}`);
            }
        }
    }

    public getStatus(uuid: string): MatterRegistrationStatus | undefined {
        return this.registrations.get(uuid)?.status;
    }

    public getPendingCount(uuid: string): number {
        return this.registrations.get(uuid)?.pendingStateUpdates.length ?? 0;
    }

    private mapperDeps() {
        return {
            api: this.api,
            log: this.log,
            getWsClient: this.getWsClient,
            momentaryAutoOffMs: this.momentaryAutoOffMs,
        };
    }

    private async registerAccessory(device: KseniaDevice): Promise<void> {
        const persistedFallback = device.type === 'thermostat' && this.thermostatFallbackUUIDs.has(device.id);
        const matterAccessory = persistedFallback
            ? mapThermostatAsTemperatureSensor(device as KseniaThermostat, this.mapperDeps())
            : deviceToMatterAccessory(device, this.mapperDeps());
        if (!matterAccessory) return;

        const reg: MatterRegistration = {
            uuid: device.id,
            displayName: device.name,
            deviceType: device.type,
            matterAccessory,
            status: 'pending',
            recoveryAttempts: 0,
            pendingStateUpdates: buildStateUpdates(device, persistedFallback),
        };
        this.registrations.set(device.id, reg);

        const fromCache = this.cachedUUIDs.has(device.id);
        if (fromCache) {
            this.log.info(`[Matter] resumed from cache: ${device.name} (${device.type})${persistedFallback ? ' [fallback]' : ''}`);
            // The Matter storage already holds the endpoint — skip register, just probe.
            void this.completeRegistration(device.id, /*skipRegister=*/ true);
            return;
        }

        this.log.info(`[Matter] register requested: ${device.name} (${device.type})${persistedFallback ? ' [fallback]' : ''}`);
        try {
            await this.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [matterAccessory]);
        } catch (err) {
            await this.handleRegisterFailure(device, err);
            return;
        }
        void this.completeRegistration(device.id);
    }

    private async completeRegistration(uuid: string, skipRegister = false): Promise<void> {
        const reg = this.registrations.get(uuid);
        if (!reg || reg.status !== 'pending') return;

        // Cache-resume path: trust the Homebridge accessory cache. The Matter
        // storage holds the endpoint — even if matter.js hasn't restored it yet
        // at the moment we probe, it will, and our updates go through the
        // state-update queue anyway (which retries naturally on first failure).
        // We do a quick best-effort probe to surface the rare "endpoint really
        // gone" case, but never re-register on a soft timeout.
        if (skipRegister) {
            await probeUntilQueryable(this.api, this.log, (e) => this.fmtErr(e), reg, {
                timeoutMs: 2000,
                initialDelayMs: 200,
                maxDelayMs: 500,
            });
            reg.status = 'registered';
            reg.registeredAt = Date.now();
            this.stateUpdateQueue.markReadyAfterBootstrap(reg);
            this.stateUpdateQueue.scheduleFlush(uuid);
            return;
        }

        const queryable = await probeUntilQueryable(this.api, this.log, (e) => this.fmtErr(e), reg);
        if (!queryable) {
            await handleMissingRegisteredAccessory(reg, this.recoveryDeps());
            return;
        }

        reg.status = 'registered';
        reg.registeredAt = Date.now();
        // After successful register as real Thermostat, drop any stale fallback marker.
        if (reg.deviceType === 'thermostat' && !this.isFallbackAccessory(reg)) {
            if (this.thermostatFallbackUUIDs.delete(uuid)) this.fallbackStore.remove(uuid);
        }
        this.stateUpdateQueue.markReadyAfterBootstrap(reg);
        this.log.info(`[Matter] registered: ${reg.displayName}`);
        this.stateUpdateQueue.scheduleFlush(uuid);
    }

    private isFallbackAccessory(reg: MatterRegistration): boolean {
        const clusters = reg.matterAccessory.clusters ?? {};
        return 'temperatureMeasurement' in clusters && !('thermostat' in clusters);
    }

    private async handleRegisterFailure(device: KseniaDevice, err: unknown): Promise<void> {
        const reg = this.registrations.get(device.id)!;
        const msg = this.fmtErr(err);

        if (device.type === 'thermostat' && MATTER_THERMOSTAT_FALLBACK_TO_TEMPERATURE_SENSOR) {
            this.log.warn(
                `Matter Thermostat registration failed for ${device.name}; falling back to TemperatureSensor. Error: ${msg}`,
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

    private enqueueStateFor(device: KseniaDevice): void {
        const reg = this.registrations.get(device.id);
        if (!reg) return;
        reg.matterAccessory.context.device = device;
        const fallback = device.type === 'thermostat' && this.thermostatFallbackUUIDs.has(device.id);
        for (const u of buildStateUpdates(device, fallback)) {
            const idx = reg.pendingStateUpdates.findIndex(
                (p) => p.clusterName === u.clusterName && p.partId === u.partId,
            );
            if (idx >= 0) reg.pendingStateUpdates[idx] = u;
            else reg.pendingStateUpdates.push(u);
        }
    }

    private async refreshAccessoryMetadata(device: KseniaDevice, reg: MatterRegistration): Promise<void> {
        const fallback = device.type === 'thermostat' && this.thermostatFallbackUUIDs.has(device.id);
        const matterAccessory = fallback
            ? mapThermostatAsTemperatureSensor(device as KseniaThermostat, this.mapperDeps())
            : deviceToMatterAccessory(device, this.mapperDeps());
        if (!matterAccessory) return;
        if (!this.hasMetadataChanged(reg.matterAccessory, matterAccessory)) return;
        reg.matterAccessory = matterAccessory;
        reg.displayName = matterAccessory.displayName;
    }

    private hasMetadataChanged(previous: MatterAccessory, next: MatterAccessory): boolean {
        return previous.displayName !== next.displayName
            || previous.manufacturer !== next.manufacturer
            || previous.model !== next.model
            || previous.serialNumber !== next.serialNumber
            || previous.firmwareRevision !== next.firmwareRevision;
    }

    private fmtErr(err: unknown): string {
        return err instanceof Error ? err.message : String(err);
    }

    private recoveryDeps(): Parameters<typeof handleMissingRegisteredAccessory>[1] {
        return {
            api: this.api,
            log: this.log,
            thermostatFallbackUUIDs: this.thermostatFallbackUUIDs,
            getWsClient: this.getWsClient,
            scheduleComplete: (uuid) => { void this.completeRegistration(uuid); },
            fmtErr: (err) => this.fmtErr(err),
            thermostatFallbackEnabled: MATTER_THERMOSTAT_FALLBACK_TO_TEMPERATURE_SENSOR,
            momentaryAutoOffMs: this.momentaryAutoOffMs,
            onFallbackPersist: (uuid) => this.fallbackStore.add(uuid),
        };
    }
}
