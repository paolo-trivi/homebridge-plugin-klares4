import type { API, Logger } from 'homebridge';
import type { MatterAccessory } from 'homebridge';
import type { KseniaDevice, KseniaThermostat } from '../types';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings';
import type { KseniaWebSocketClient } from '../websocket-client';
import { deviceToMatterAccessory, mapThermostatAsTemperatureSensor, hasAccessoryMetadataChanged } from './matter-device-mapper';
import { buildStateUpdates, mergeStateUpdates } from './matter-state-updates';
import {
    handleMissingRegisteredAccessory,
    isFallbackTemperatureSensor,
    registerFallbackAccessory,
    type MatterRegistration,
} from './matter-registration-recovery';
import { MatterStateUpdateQueue } from './matter-state-update-queue';
import { MatterFallbackStore } from './matter-fallback-store';
import { probeUntilQueryable } from './matter-register-probe';
import { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';
import { MatterPruneTracker } from './matter-prune-tracker';
import { MatterNameService } from './matter-name-service';
import { finalizeMatterNameMap } from './matter-name-finalizer';

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
    /**
     * Matter-side eligibility filter (config exclusions + `matterExposure`
     * per-type opt-out). Devices failing it are never registered and their
     * previously-registered/cached endpoints are pruned via the normal
     * 3-consecutive-cycles discipline. When omitted, everything is exposed.
     */
    isDeviceExposed?: (device: KseniaDevice) => boolean;
}

export class MatterAccessoryRegistry {
    private readonly api: API;
    private readonly log: Logger;
    private readonly getWsClient: () => KseniaWebSocketClient | undefined;
    private readonly momentaryAutoOffMs?: number;
    private readonly isDeviceExposed?: (device: KseniaDevice) => boolean;
    private readonly cachedUUIDs: Set<string> = new Set();
    private readonly cachedDevices: Map<string, KseniaDevice> = new Map();
    private readonly registrations: Map<string, MatterRegistration> = new Map();
    private readonly stateUpdateQueue: MatterStateUpdateQueue;
    private activeDiscoveredUUIDs: Set<string> = new Set();
    private readonly thermostatFallbackUUIDs: Set<string> = new Set();
    private readonly fallbackStore: MatterFallbackStore;
    private readonly thermostatEchoTracker = new MatterThermostatEchoTracker();
    private readonly pruneTracker: MatterPruneTracker;
    private readonly nameService: MatterNameService;

    constructor(deps: MatterRegistryDeps) {
        this.api = deps.api;
        this.log = deps.log;
        this.getWsClient = deps.getWsClient;
        this.momentaryAutoOffMs = deps.momentaryAutoOffMs;
        this.isDeviceExposed = deps.isDeviceExposed;
        this.fallbackStore = new MatterFallbackStore(deps.storagePath, deps.log);
        this.pruneTracker = new MatterPruneTracker(this.log, deps.storagePath);
        this.nameService = new MatterNameService(deps.storagePath, deps.log);
        for (const uuid of this.fallbackStore.load()) this.thermostatFallbackUUIDs.add(uuid);

        this.stateUpdateQueue = new MatterStateUpdateQueue(
            this.api,
            this.log,
            this.registrations,
            (err) => this.fmtErr(err),
            (uuid, clusterName, attrs) => {
                // Record every thermostat-cluster push so the mapper's attribute-change
                // handlers can recognise their own state echo and skip forwarding it
                // back to Lares4. See matter-thermostat-echo-tracker.ts for the loop
                // failure mode this prevents.
                if (clusterName === 'thermostat') this.thermostatEchoTracker.recordPushed(uuid, attrs);
            },
        );
    }

    public get isEnabled(): boolean {
        return !!this.api.matter;
    }

    public configureCachedAccessory(accessory: MatterAccessory): void {
        this.cachedUUIDs.add(accessory.UUID);
        // Keep the cached device snapshot: it lets the prune pass identify (and
        // eventually unregister) endpoints whose type was disabled via
        // `matterExposure` after they were registered in a previous session.
        const device = accessory.context?.device as KseniaDevice | undefined;
        if (device?.id && device.type) this.cachedDevices.set(accessory.UUID, device);
        this.log.debug(`[Matter] Cached accessory: ${accessory.displayName} (${accessory.UUID})`);
    }

    public startDiscoveryCycle(): void {
        this.activeDiscoveredUUIDs = new Set();
        this.pruneTracker.startCycle();
    }

    public async addOrUpdateAccessory(device: KseniaDevice): Promise<void> {
        if (!this.api.matter) return;
        if (this.isDeviceExposed && !this.isDeviceExposed(device)) {
            this.log.debug(`[Matter] not exposed (config): ${device.name} (${device.type}, uuid=${device.id})`);
            return;
        }
        this.activeDiscoveredUUIDs.add(device.id);

        const existing = this.registrations.get(device.id);
        if (existing) {
            switch (existing.status) {
                case 'pending':
                    this.enqueueStateFor(device);
                    return;
                case 'registered':
                    this.refreshAccessoryMetadata(device, existing);
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
        if (this.isDeviceExposed && !this.isDeviceExposed(device)) return;
        // A device pushing realtime state is alive by definition: mark it seen
        // so a partial discovery can't count it towards the stale-prune threshold.
        this.activeDiscoveredUUIDs.add(device.id);
        const existing = this.registrations.get(device.id);
        if (!existing) {
            await this.registerAccessory(device);
            return;
        }
        if (existing.status === 'failed' || existing.status === 'skipped') return;
        this.enqueueStateFor(device);
        this.stateUpdateQueue.scheduleFlush(device.id);
    }

    /**
     * Two-phase naming, phase 2 — called by the platform at initial-sync
     * complete. See `matter-name-finalizer.ts` for the mechanism.
     */
    public async finalizeNameMap(devices: KseniaDevice[]): Promise<void> {
        if (!this.api.matter) return;
        await finalizeMatterNameMap(devices, {
            api: this.api,
            log: this.log,
            nameService: this.nameService,
            registrations: this.registrations,
            recordMetadataChanged: () => this.pruneTracker.recordMetadataChanged(),
            registerRenamed: (device) => this.registerAccessory(device, true),
            fmtErr: (err) => this.fmtErr(err),
        });
    }

    public async pruneStaleAccessories(): Promise<void> {
        if (!this.api.matter) return;
        await this.pruneTracker.runPruneCycle({
            api: this.api,
            registrations: this.registrations,
            activeDiscoveredUUIDs: this.activeDiscoveredUUIDs,
            cachedUUIDs: this.cachedUUIDs,
            cachedDevices: this.cachedDevices,
            isDeviceExposed: this.isDeviceExposed,
            thermostatFallbackUUIDs: this.thermostatFallbackUUIDs,
            fallbackStore: this.fallbackStore,
            thermostatEchoTracker: this.thermostatEchoTracker,
            fmtErr: (err) => this.fmtErr(err),
        });
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
            thermostatEchoTracker: this.thermostatEchoTracker,
            resolveDisplayName: (device: KseniaDevice) => this.nameService.resolveName(device),
        };
    }

    private async registerAccessory(device: KseniaDevice, isRename = false): Promise<void> {
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
        if (!isRename) {
            if (fromCache) this.pruneTracker.recordCachedRestore();
            else this.pruneTracker.recordNewlyRegistered();
        }
        // Include the *post-sanitisation* displayName + length so register failures
        // can be diagnosed without re-deriving the sanitiser output: the original
        // `device.name` may exceed Matter's 32-char nodeLabel limit while the
        // displayName actually sent to matter.js does not.
        const matterName = matterAccessory.displayName;
        const nameAnnotation = matterName !== device.name
            ? ` -> "${matterName}" [${matterName.length}ch]`
            : ` [${matterName.length}ch]`;
        this.log.info(
            `[Matter] register requested: ${device.name}${nameAnnotation} `
            + `(${device.type}, uuid=${device.id})`
            + `${fromCache ? ' [cache restore]' : ''}${persistedFallback ? ' [fallback]' : ''}${isRename ? ' [rename]' : ''}`,
        );
        // We must always call registerPlatformAccessories — the MatterServer keeps
        // a runtime accessory map that is populated only on register. The Homebridge
        // accessory cache (configureMatterAccessory) is necessary but NOT sufficient:
        // without register, `updateAccessoryState` will fail with
        // `Accessory <UUID> not found or not registered` even though the matter.js
        // storage still holds the fabric/ACL. The same UUID is reused, so Apple Home
        // rooms and automations survive the re-register.
        try {
            // Record the thermostat-cluster values we're about to register with
            // matter.js as already-pushed, so the very first handler firings (which
            // some matter.js versions emit eagerly after registerPlatformAccessories)
            // are recognised as echoes of our own register payload, not external commands.
            if (device.type === 'thermostat' && !persistedFallback) {
                const tc = matterAccessory.clusters?.thermostat as Record<string, unknown> | undefined;
                if (tc) this.thermostatEchoTracker.recordPushed(device.id, tc);
            }
            await this.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [matterAccessory]);
            reg.registeredDisplayName = matterAccessory.displayName;
        } catch (err) {
            await this.handleRegisterFailure(device, err);
            return;
        }
        void this.completeRegistration(device.id);
    }

    private async completeRegistration(uuid: string): Promise<void> {
        const reg = this.registrations.get(uuid);
        if (!reg || reg.status !== 'pending') return;

        const queryable = await probeUntilQueryable(this.api, this.log, (e) => this.fmtErr(e), reg);
        if (!queryable) {
            await handleMissingRegisteredAccessory(reg, this.recoveryDeps());
            return;
        }

        reg.status = 'registered';
        reg.registeredAt = Date.now();
        // After successful register as real Thermostat, drop any stale fallback marker.
        if (reg.deviceType === 'thermostat' && !isFallbackTemperatureSensor(reg)) {
            if (this.thermostatFallbackUUIDs.delete(uuid)) this.fallbackStore.remove(uuid);
        }
        this.stateUpdateQueue.markReadyAfterBootstrap(reg);
        this.log.info(`[Matter] registered: ${reg.displayName}`);
        this.stateUpdateQueue.scheduleFlush(uuid);
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
        mergeStateUpdates(reg.pendingStateUpdates, device, fallback);
    }

    private refreshAccessoryMetadata(device: KseniaDevice, reg: MatterRegistration): void {
        const fallback = device.type === 'thermostat' && this.thermostatFallbackUUIDs.has(device.id);
        const matterAccessory = fallback
            ? mapThermostatAsTemperatureSensor(device as KseniaThermostat, this.mapperDeps())
            : deviceToMatterAccessory(device, this.mapperDeps());
        if (!matterAccessory) return;
        if (!hasAccessoryMetadataChanged(reg.matterAccessory, matterAccessory)) {
            this.pruneTracker.recordMetadataUnchanged();
            return;
        }
        this.pruneTracker.recordMetadataChanged();
        reg.matterAccessory = matterAccessory;
        reg.displayName = matterAccessory.displayName;
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
            resolveDisplayName: (device: KseniaDevice) => this.nameService.resolveName(device),
        };
    }
}
