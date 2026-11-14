import type { Logger } from 'homebridge';
import type { MqttBridge } from '../mqtt-bridge';
import type { KseniaDevice } from '../types';
import type { AccessoryRegistry } from './accessory-registry';
import type { DeviceListService } from './device-list-service';
import type { DiscoveryService } from './discovery-service';
import type { MatterAccessoryRegistry } from './matter-accessory-registry';

export interface DeviceEventRouterDeps {
    log: Logger;
    discoveryService: DiscoveryService;
    deviceListService: DeviceListService;
    accessoryRegistry: AccessoryRegistry;
    matterRegistry: MatterAccessoryRegistry;
    getMqttBridge: () => MqttBridge | undefined;
}

/**
 * Fans the WebSocket client's device events out to the three consumers: HAP
 * (`accessoryRegistry`), MQTT (`mqttBridge`) and Matter (`matterRegistry`).
 * HAP and MQTT get the shared name (`customNames`); Matter gets its own
 * derived name (invariant 3: never the HAP/MQTT snapshot).
 */
export class DeviceEventRouter {
    private readonly discoveredDevices: Map<string, KseniaDevice> = new Map();
    private readonly matterDevices: Map<string, KseniaDevice> = new Map();

    constructor(private readonly deps: DeviceEventRouterDeps) {}

    /** Latest Matter-named snapshot of every routed device. */
    public get matterSnapshots(): Iterable<KseniaDevice> {
        return this.matterDevices.values();
    }

    public handleDeviceDiscovered(device: KseniaDevice): void {
        const { discoveryService, log } = this.deps;
        this.discoveredDevices.set(device.id, device);
        this.deps.deviceListService.saveDevicesList(this.discoveredDevices.values());

        if (discoveryService.shouldExcludeDevice(device)) {
            log.info(`Device excluded: ${device.type} - ${device.name}`);
            return;
        }

        const sharedDevice = discoveryService.applyCustomName(device);
        const matterDevice = discoveryService.applyMatterName(device);
        this.matterDevices.set(device.id, matterDevice);
        log.info(`Device discovered: ${sharedDevice.type} - ${sharedDevice.name}`);
        this.deps.accessoryRegistry.addAccessory(sharedDevice);
        this.deps.matterRegistry.addOrUpdateAccessory(matterDevice).catch((err: unknown) => {
            log.warn(`[Matter] Registration error for ${matterDevice.name}:`, err instanceof Error ? err.message : String(err));
        });
    }

    public handleDeviceStatusUpdate(device: KseniaDevice): void {
        const { discoveryService, log } = this.deps;
        const sharedDevice = discoveryService.applyCustomName(device);
        const matterDevice = discoveryService.applyMatterName(device);
        this.discoveredDevices.set(device.id, device);
        this.matterDevices.set(device.id, matterDevice);
        log.debug(`Device status update: ${sharedDevice.name}`);
        this.deps.accessoryRegistry.updateAccessory(sharedDevice);
        this.deps.getMqttBridge()?.publishDeviceState(sharedDevice);
        this.deps.matterRegistry.updateAccessoryState(matterDevice).catch((err: unknown) => {
            log.debug(`[Matter] State update error for ${matterDevice.name}:`, err instanceof Error ? err.message : String(err));
        });
    }
}
