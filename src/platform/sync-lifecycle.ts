import type { Logger } from 'homebridge';
import { runIsolated } from '../isolation';
import type { KseniaDevice } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';
import type { AccessoryRegistry } from './accessory-registry';
import type { DeviceEventRouter } from './device-event-router';
import type { MatterAccessoryRegistry } from './matter-accessory-registry';
import { familiesOf, type SyncOutcome } from './prune-policy';

export interface SyncLifecycleDeps {
    log: Logger;
    accessoryRegistry: AccessoryRegistry;
    matterRegistry: MatterAccessoryRegistry;
    /** Matter-named snapshots of the devices currently exposed on Matter. */
    eligibleMatterDevices: () => KseniaDevice[];
    /** Runs once, at the end of the first complete sync, with every device ID the panel reported. */
    onFirstSyncComplete?: (discoveredIds: ReadonlySet<string>) => void;
}

/** A completed sync, as the Matter prune sees it. */
interface CompletedSync extends SyncOutcome {
    epoch: number;
}

/**
 * Session wiring of the panel client and the discovery-sync bookkeeping
 * shared by HAP and Matter.
 *
 * Every login starts a sync (`onSyncStarted`): HAP and Matter open a new
 * discovery cycle, so "seen" always means "seen in this sync", and the
 * families that answered are the families of the devices the panel listed in
 * this sync. Both prunes apply the same discipline (`prune-policy.ts`) to that.
 *
 * At the end of a sync: HAP prune, then the Matter name-map finalize and
 * prune. The Matter chain is single-flight (one run, at most one queued),
 * prunes a sync at most once and only while that sync is the current one.
 */
export class SyncLifecycle {
    private epoch = 0;
    /** Every device the panel listed in the current sync, excluded ones included. */
    private readonly syncDeviceIds = new Set<string>();
    private client?: KseniaWebSocketClient;
    private completed?: CompletedSync;
    private prunedEpoch?: number;
    private matterRun?: Promise<void>;
    private matterRunQueued = false;
    /** Every device the panel reported, excluded ones included (an override on them still has a target). */
    private readonly discoveredIds = new Set<string>();
    private firstSyncReported = false;

    constructor(private readonly deps: SyncLifecycleDeps) {}

    public attach(client: KseniaWebSocketClient, deviceEvents: DeviceEventRouter): void {
        const { matterRegistry } = this.deps;
        this.client = client;
        client.onSyncStarted = (): void => this.startSync();
        client.onDeviceDiscovered = (device: KseniaDevice): void => {
            this.discoveredIds.add(device.id);
            this.syncDeviceIds.add(device.id);
            deviceEvents.handleDeviceDiscovered(device);
        };
        client.onDeviceStatusUpdate = (device: KseniaDevice): void => {
            this.discoveredIds.add(device.id);
            deviceEvents.handleDeviceStatusUpdate(device);
        };
        client.onInitialSyncComplete = (): void => this.handleInitialSyncComplete();
        client.onConnected = (): void => matterRegistry.setPanelReachable(true);
        client.onDisconnected = (): void => matterRegistry.setPanelReachable(false);
        // Not connected yet: if the panel stays unreachable past the grace
        // period, the endpoints Homebridge restored from its cache say so.
        matterRegistry.setPanelReachable(false);
    }

    /** Opens the discovery cycle of a new sync on HAP and Matter. */
    public startSync(): void {
        this.epoch += 1;
        this.syncDeviceIds.clear();
        this.deps.accessoryRegistry.startDiscoveryCycle();
        this.deps.matterRegistry.startDiscoveryCycle();
    }

    public handleInitialSyncComplete(): void {
        const { log } = this.deps;
        log.info('Initial synchronization completed, finalizing Matter name-map and pruning stale accessories...');
        const answeredFamilies = familiesOf(this.syncDeviceIds);
        const { client } = this;
        runIsolated(log, 'HAP accessory prune', () => this.deps.accessoryRegistry.pruneStaleAccessories({
            answeredFamilies,
            isHiddenByPolicy: (device: KseniaDevice): boolean => device.type === 'scenario'
                && !!client?.isScenarioSuppressed(device.id),
        }));
        this.completed = { epoch: this.epoch, answeredFamilies };
        if (!this.firstSyncReported) {
            this.firstSyncReported = true;
            const { onFirstSyncComplete } = this.deps;
            if (onFirstSyncComplete) runIsolated(log, 'Config override check', () => onFirstSyncComplete(this.discoveredIds));
        }
        this.scheduleMatterPass();
    }

    private scheduleMatterPass(): void {
        if (this.matterRun) {
            this.matterRunQueued = true;
            return;
        }
        this.matterRun = this.runMatterPass().finally((): void => {
            this.matterRun = undefined;
            if (this.matterRunQueued) {
                this.matterRunQueued = false;
                this.scheduleMatterPass();
            }
        });
    }

    private async runMatterPass(): Promise<void> {
        const { log, matterRegistry } = this.deps;
        const sync = this.completed;
        // Two-phase naming, phase 2: with the full device set known, batch-compute
        // the authoritative name-map, persist it and refresh outliers — then prune.
        try {
            await matterRegistry.finalizeNameMap(this.deps.eligibleMatterDevices());
        } catch (err: unknown) {
            log.warn('[Matter] Name-map finalize error:', err instanceof Error ? err.message : String(err));
        }
        if (!sync || sync.epoch !== this.epoch || sync.epoch === this.prunedEpoch) {
            log.debug('[Matter] Prune skipped: the sync it belonged to was superseded or already pruned');
            return;
        }
        this.prunedEpoch = sync.epoch;
        try {
            await matterRegistry.pruneStaleAccessories(sync);
        } catch (err: unknown) {
            log.warn('[Matter] Prune error:', err instanceof Error ? err.message : String(err));
        }
    }
}
