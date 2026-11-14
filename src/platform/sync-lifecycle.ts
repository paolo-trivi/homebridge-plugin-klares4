import type { Logger } from 'homebridge';
import type { KseniaDevice } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';
import type { AccessoryRegistry } from './accessory-registry';
import type { DeviceEventRouter } from './device-event-router';
import type { MatterAccessoryRegistry } from './matter-accessory-registry';

export interface SyncLifecycleDeps {
    log: Logger;
    accessoryRegistry: AccessoryRegistry;
    matterRegistry: MatterAccessoryRegistry;
    /** Matter-named snapshots of the devices currently exposed on Matter. */
    eligibleMatterDevices: () => KseniaDevice[];
}

/**
 * Session wiring of the panel client and the discovery-sync bookkeeping
 * shared by HAP and Matter: opening a discovery cycle, and the end-of-sync
 * work (HAP prune, Matter name-map finalize then prune).
 */
export class SyncLifecycle {
    constructor(private readonly deps: SyncLifecycleDeps) {}

    public attach(client: KseniaWebSocketClient, deviceEvents: DeviceEventRouter): void {
        const { matterRegistry } = this.deps;
        client.onDeviceDiscovered = (device: KseniaDevice): void => {
            deviceEvents.handleDeviceDiscovered(device);
        };
        client.onDeviceStatusUpdate = (device: KseniaDevice): void => {
            deviceEvents.handleDeviceStatusUpdate(device);
        };
        client.onInitialSyncComplete = (): void => this.handleInitialSyncComplete();
        client.onConnected = (): void => matterRegistry.setPanelReachable(true);
        client.onDisconnected = (): void => matterRegistry.setPanelReachable(false);
    }

    public startDiscoveryCycle(): void {
        this.deps.accessoryRegistry.startDiscoveryCycle();
        this.deps.matterRegistry.startDiscoveryCycle();
    }

    public handleInitialSyncComplete(): void {
        const { log, matterRegistry } = this.deps;
        log.info('Initial synchronization completed, finalizing Matter name-map and pruning stale accessories...');
        this.deps.accessoryRegistry.pruneStaleAccessories();
        // Two-phase naming, phase 2: with the full device set known, batch-compute
        // the authoritative name-map, persist it and refresh outliers — then prune.
        matterRegistry
            .finalizeNameMap(this.deps.eligibleMatterDevices())
            .catch((err: unknown) => {
                log.warn('[Matter] Name-map finalize error:', err instanceof Error ? err.message : String(err));
            })
            .then(() => matterRegistry.pruneStaleAccessories())
            .catch((err: unknown) => {
                log.warn('[Matter] Prune error:', err instanceof Error ? err.message : String(err));
            });
    }
}
