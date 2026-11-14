import type { Logger } from 'homebridge';
import { runIsolated } from '../isolation';
import type { KseniaDevice } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';
import type { AccessoryRegistry } from './accessory-registry';
import type { DeviceEventRouter } from './device-event-router';
import { discoveryFamily } from './hap-prune-policy';
import type { MatterAccessoryRegistry } from './matter-accessory-registry';

export interface SyncLifecycleDeps {
    log: Logger;
    accessoryRegistry: AccessoryRegistry;
    matterRegistry: MatterAccessoryRegistry;
    /** Matter-named snapshots of the devices currently exposed on Matter. */
    eligibleMatterDevices: () => KseniaDevice[];
}

/** What the Matter prune of a completed sync may do. */
interface CompletedSync {
    epoch: number;
    /** Discovery families seen in earlier syncs that produced no device in this one. */
    silentFamilies: string[];
}

/**
 * Session wiring of the panel client and the discovery-sync bookkeeping
 * shared by HAP and Matter.
 *
 * Every login starts a sync (`onSyncStarted`): HAP and Matter open a new
 * discovery cycle, so "seen" always means "seen in this sync" and the prune
 * guards (family that answered, consecutive missed syncs, 50% floor) judge
 * each sync on its own, reconnects included.
 *
 * At the end of a sync: HAP prune, then the Matter name-map finalize and
 * prune. The Matter chain is single-flight (one run, at most one queued),
 * prunes a sync at most once and only while that sync is the current one.
 * The Matter prune tracker has no per-family guard yet, so a sync in which a
 * family seen before produced no device at all (a failed discovery read) does
 * not run the Matter prune.
 */
export class SyncLifecycle {
    private epoch = 0;
    private readonly knownFamilies = new Set<string>();
    private readonly syncFamilies = new Set<string>();
    private completed?: CompletedSync;
    private prunedEpoch?: number;
    private matterRun?: Promise<void>;
    private matterRunQueued = false;

    constructor(private readonly deps: SyncLifecycleDeps) {}

    public attach(client: KseniaWebSocketClient, deviceEvents: DeviceEventRouter): void {
        const { matterRegistry } = this.deps;
        client.onSyncStarted = (): void => this.startSync();
        client.onDeviceDiscovered = (device: KseniaDevice): void => {
            if (deviceEvents.handleDeviceDiscovered(device)) this.recordSeen(device);
        };
        client.onDeviceStatusUpdate = (device: KseniaDevice): void => {
            if (deviceEvents.handleDeviceStatusUpdate(device)) this.recordSeen(device);
        };
        client.onInitialSyncComplete = (): void => this.handleInitialSyncComplete();
        client.onConnected = (): void => matterRegistry.setPanelReachable(true);
        client.onDisconnected = (): void => matterRegistry.setPanelReachable(false);
    }

    /** Opens the discovery cycle of a new sync on HAP and Matter. */
    public startSync(): void {
        this.epoch += 1;
        this.syncFamilies.clear();
        this.deps.accessoryRegistry.startDiscoveryCycle();
        this.deps.matterRegistry.startDiscoveryCycle();
    }

    public handleInitialSyncComplete(): void {
        const { log } = this.deps;
        log.info('Initial synchronization completed, finalizing Matter name-map and pruning stale accessories...');
        runIsolated(log, 'HAP accessory prune', () => this.deps.accessoryRegistry.pruneStaleAccessories());
        this.completed = {
            epoch: this.epoch,
            silentFamilies: [...this.knownFamilies].filter((family) => !this.syncFamilies.has(family)),
        };
        for (const family of this.syncFamilies) this.knownFamilies.add(family);
        this.scheduleMatterPass();
    }

    private recordSeen(device: KseniaDevice): void {
        this.syncFamilies.add(discoveryFamily(device.id));
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
        if (sync.silentFamilies.length > 0) {
            log.info(
                `[Matter] Prune skipped for this sync: no device of ${sync.silentFamilies.join(', ')} `
                + 'was reported (partial discovery)',
            );
            return;
        }
        this.prunedEpoch = sync.epoch;
        try {
            await matterRegistry.pruneStaleAccessories();
        } catch (err: unknown) {
            log.warn('[Matter] Prune error:', err instanceof Error ? err.message : String(err));
        }
    }
}
