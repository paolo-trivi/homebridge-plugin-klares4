import type { API, Logger } from 'homebridge';
import type { MatterAccessory } from 'homebridge';
import type { KseniaDevice } from '../types';
import { createStateUpdateQueue, type CachedEndpointLabel } from './matter-registry-state';
import { canRetryRegistration, type MatterRegistration } from './matter-registration-recovery';
import { needsDimmableUpgrade } from './matter-light-capability';
import type { MatterStateUpdateQueue } from './matter-state-update-queue';
import { MatterReachability } from './matter-reachability';
import { MatterFallbackStore } from './matter-fallback-store';
import { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';
import { MatterPruneTracker } from './matter-prune-tracker';
import { MatterNameService } from './matter-name-service';
import { adoptCachedState } from '../device-observation';
import { finalizeMatterNameMap } from './matter-name-finalizer';
import { MatterTopologyCoordinator } from './matter-topology-coordinator';
import { fmtErr, MatterRegistrationFlow } from './matter-registration-flow';
import { resolveMatterTimings, type MatterRegistrationStatus, type MatterRegistryDeps } from './matter-registry-types';
import type { SyncOutcome } from './prune-policy';

export type { MatterRegistrationStatus, MatterRegistryDeps, MatterTimings } from './matter-registry-types';

/**
 * Facade of the Matter side: endpoints restored from the Homebridge cache,
 * registrations of discovered devices (`matter-registration-flow.ts`), state
 * updates, the name-map finalize, the prune (`matter-prune-tracker.ts`) and
 * the panel reachability (`matter-reachability.ts`).
 */
export class MatterAccessoryRegistry {
    private readonly api: API;
    private readonly log: Logger;
    private readonly isDeviceExposed?: (device: KseniaDevice) => boolean;
    private readonly cachedUUIDs: Set<string> = new Set();
    private readonly cachedDevices: Map<string, KseniaDevice> = new Map();
    private readonly cachedLabels: Map<string, CachedEndpointLabel> = new Map();
    private readonly registrations: Map<string, MatterRegistration> = new Map();
    private readonly stateUpdateQueue: MatterStateUpdateQueue;
    private activeDiscoveredUUIDs: Set<string> = new Set();
    private readonly thermostatFallbackUUIDs: Set<string> = new Set();
    private readonly fallbackStore: MatterFallbackStore;
    private readonly thermostatEchoTracker = new MatterThermostatEchoTracker();
    private readonly pruneTracker: MatterPruneTracker;
    private readonly nameService: MatterNameService;
    private readonly topologyCoordinator: MatterTopologyCoordinator;
    private readonly reachability: MatterReachability;
    private readonly flow: MatterRegistrationFlow;

    constructor(deps: MatterRegistryDeps) {
        this.api = deps.api;
        this.log = deps.log;
        this.isDeviceExposed = deps.isDeviceExposed;
        const timings = resolveMatterTimings(deps.timings);
        this.fallbackStore = new MatterFallbackStore(deps.storagePath, deps.log);
        this.pruneTracker = new MatterPruneTracker(this.log, deps.storagePath);
        this.nameService = new MatterNameService(deps.storagePath, deps.log);
        this.topologyCoordinator = new MatterTopologyCoordinator(this.api, this.log, deps.unregisterTimeoutMs, timings.unregisterSettleMs);
        for (const uuid of this.fallbackStore.load()) this.thermostatFallbackUUIDs.add(uuid);

        this.stateUpdateQueue = createStateUpdateQueue(this.api, this.log, this.registrations, this.thermostatEchoTracker);
        this.reachability = new MatterReachability(this.api, this.log, () => this.endpointUUIDs(), timings.unreachableGraceMs);
        this.flow = new MatterRegistrationFlow({
            api: this.api,
            log: this.log,
            getWsClient: deps.getWsClient,
            momentaryAutoOffMs: deps.momentaryAutoOffMs,
            timings,
            recoveryRequests: deps.recoveryRequests ?? {},
            registrations: this.registrations,
            cachedUUIDs: this.cachedUUIDs,
            cachedDevices: this.cachedDevices,
            cachedLabels: this.cachedLabels,
            thermostatFallbackUUIDs: this.thermostatFallbackUUIDs,
            fallbackStore: this.fallbackStore,
            thermostatEchoTracker: this.thermostatEchoTracker,
            pruneTracker: this.pruneTracker,
            nameService: this.nameService,
            topologyCoordinator: this.topologyCoordinator,
            stateUpdateQueue: this.stateUpdateQueue,
            reachability: this.reachability,
            updateAccessoryState: (device) => this.updateAccessoryState(device),
        });
    }

    /**
     * Mirrors the panel connection (`reachable`) on every endpoint of the
     * plugin, the cache-restored ones included. `false` is published after the
     * grace period, `true` at once.
     */
    public setPanelReachable(reachable: boolean): void {
        if (this.api.matter) this.reachability.set(reachable);
    }

    public get isEnabled(): boolean {
        return !!this.api.matter;
    }

    public configureCachedAccessory(accessory: MatterAccessory): void {
        this.cachedUUIDs.add(accessory.UUID);
        this.cachedLabels.set(accessory.UUID, { displayName: accessory.displayName, deviceTypeName: accessory.deviceType?.name });
        this.topologyCoordinator.remember(accessory);
        const device = accessory.context?.device as KseniaDevice | undefined;
        if (device?.id && device.type) {
            adoptCachedState(accessory.context, device);
            this.cachedDevices.set(accessory.UUID, device);
        }
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
                    this.flow.enqueueStateFor(device);
                    return;
                case 'registered':
                    this.flow.refreshMetadata(device, existing);
                    this.flow.enqueueStateFor(device);
                    this.stateUpdateQueue.scheduleFlush(device.id);
                    return;
                case 'failed':
                case 'skipped':
                    if (!canRetryRegistration(existing)) return;
            }
        }

        await this.flow.register(device);
    }

    public async updateAccessoryState(device: KseniaDevice): Promise<void> {
        if (!this.api.matter) return;
        if (this.isDeviceExposed && !this.isDeviceExposed(device)) return;
        this.activeDiscoveredUUIDs.add(device.id);
        const existing = this.registrations.get(device.id);
        if (!existing || canRetryRegistration(existing)) {
            await this.flow.register(device);
            return;
        }
        if (existing.status === 'failed' || existing.status === 'skipped') return;
        if (needsDimmableUpgrade(existing, device)) {
            await this.flow.upgradeToDimmable(device);
            return;
        }
        this.flow.enqueueStateFor(device);
        this.stateUpdateQueue.scheduleFlush(device.id);
    }

    /**
     * Two-phase naming, phase 2 — called by the platform at initial-sync
     * complete. See `matter-name-finalizer.ts` for the mechanism.
     */
    public async finalizeNameMap(devices: KseniaDevice[]): Promise<void> {
        if (!this.api.matter) return;
        await finalizeMatterNameMap(devices, {
            topologyCoordinator: this.topologyCoordinator,
            log: this.log,
            nameService: this.nameService,
            registrations: this.registrations,
            recordMetadataChanged: () => this.pruneTracker.recordMetadataChanged(),
            registerRenamed: (device, inheritUniqueId) => this.flow.register(device, { reason: 'rename', inheritUniqueId }),
            fmtErr,
        });
    }

    /** `sync`: what the completed sync reported (see `sync-lifecycle.ts`); omitted, the cycle's own view. */
    public async pruneStaleAccessories(sync?: Partial<SyncOutcome>): Promise<void> {
        if (!this.api.matter) return;
        await this.pruneTracker.runPruneCycle({
            api: this.api,
            topologyCoordinator: this.topologyCoordinator,
            registrations: this.registrations,
            activeDiscoveredUUIDs: this.activeDiscoveredUUIDs,
            cachedUUIDs: this.cachedUUIDs,
            cachedDevices: this.cachedDevices,
            isDeviceExposed: this.isDeviceExposed,
            answeredFamilies: sync?.answeredFamilies,
            thermostatFallbackUUIDs: this.thermostatFallbackUUIDs,
            fallbackStore: this.fallbackStore,
            thermostatEchoTracker: this.thermostatEchoTracker,
            fmtErr,
        });
    }

    public getStatus(uuid: string): MatterRegistrationStatus | undefined {
        return this.registrations.get(uuid)?.status;
    }

    public getPendingCount(uuid: string): number {
        return this.registrations.get(uuid)?.pendingStateUpdates.length ?? 0;
    }

    /** Every endpoint the plugin holds on the bridge: restored from the cache or registered now. */
    private *endpointUUIDs(): Iterable<string> {
        yield* this.cachedUUIDs;
        for (const reg of this.registrations.values()) {
            if (reg.status === 'registered') yield reg.uuid;
        }
    }
}
