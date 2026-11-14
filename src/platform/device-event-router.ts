import type { Logger } from 'homebridge';
import { errorDetail, runIsolated } from '../isolation';
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

/** Thrown by HAP-NodeJS `Bridge.addBridgedAccessory` (MAX_ACCESSORIES = 149). */
const HAP_BRIDGE_LIMIT_ERROR = /^Cannot Bridge more than (\d+) Accessories$/;

/**
 * Fans the WebSocket client's device events out to the three consumers: HAP
 * (`accessoryRegistry`), MQTT (`mqttBridge`) and Matter (`matterRegistry`).
 * HAP and MQTT get the shared name (`customNames`); Matter gets its own
 * derived name (invariant 3: never the HAP/MQTT snapshot).
 *
 * The three consumers are independent: a failure in one is logged with the
 * device and the subsystem and never keeps the others from the event.
 * Devices excluded in the config reach none of them.
 */
export class DeviceEventRouter {
    private readonly discoveredDevices: Map<string, KseniaDevice> = new Map();
    private readonly matterDevices: Map<string, KseniaDevice> = new Map();
    /** Devices HAP refused for the per-bridge accessory limit: not retried this session. */
    private readonly beyondHapLimit = new Set<string>();

    constructor(private readonly deps: DeviceEventRouterDeps) {}

    /** Latest Matter-named snapshot of every routed device. */
    public get matterSnapshots(): Iterable<KseniaDevice> {
        return this.matterDevices.values();
    }

    /** Returns whether the device was routed (false: excluded, or its names could not be derived). */
    public handleDeviceDiscovered(device: KseniaDevice): boolean {
        const { discoveryService, log } = this.deps;
        this.discoveredDevices.set(device.id, device);
        runIsolated(log, 'Device list update', () => {
            this.deps.deviceListService.saveDevicesList(this.discoveredDevices.values());
        });

        if (discoveryService.shouldExcludeDevice(device)) {
            log.info(`Device excluded: ${device.type} - ${device.name}`);
            return false;
        }
        const names = this.deriveNames(device);
        if (!names) return false;
        const { sharedDevice, matterDevice } = names;
        this.matterDevices.set(device.id, matterDevice);
        log.info(`Device discovered: ${sharedDevice.type} - ${sharedDevice.name}`);

        this.isolate(device, 'HAP', () => this.addToHap(sharedDevice));
        this.isolate(device, 'Matter', () => {
            this.deps.matterRegistry.addOrUpdateAccessory(matterDevice).catch((err: unknown) => {
                log.warn(`[Matter] Registration error for ${matterDevice.name}:`, err instanceof Error ? err.message : String(err));
            });
        });
        return true;
    }

    /** Returns whether the update was routed (false: excluded, or its names could not be derived). */
    public handleDeviceStatusUpdate(device: KseniaDevice): boolean {
        const { discoveryService, log } = this.deps;
        this.discoveredDevices.set(device.id, device);
        // Exclusion holds everywhere, not only at discovery: no HAP, no Matter, no retained MQTT state.
        if (discoveryService.isDeviceExcluded(device)) return false;
        const names = this.deriveNames(device);
        if (!names) return false;
        const { sharedDevice, matterDevice } = names;
        this.matterDevices.set(device.id, matterDevice);
        log.debug(`Device status update: ${sharedDevice.name}`);

        this.isolate(device, 'HAP', () => this.deps.accessoryRegistry.updateAccessory(sharedDevice));
        this.isolate(device, 'MQTT', () => this.deps.getMqttBridge()?.publishDeviceState(sharedDevice));
        this.isolate(device, 'Matter', () => {
            this.deps.matterRegistry.updateAccessoryState(matterDevice).catch((err: unknown) => {
                log.debug(`[Matter] State update error for ${matterDevice.name}:`, err instanceof Error ? err.message : String(err));
            });
        });
        return true;
    }

    private deriveNames(device: KseniaDevice): { sharedDevice: KseniaDevice; matterDevice: KseniaDevice } | undefined {
        try {
            return {
                sharedDevice: this.deps.discoveryService.applyCustomName(device),
                matterDevice: this.deps.discoveryService.applyMatterName(device),
            };
        } catch (error: unknown) {
            this.deps.log.error(`Name derivation for ${device.id} failed: ${errorDetail(error)}`);
            return undefined;
        }
    }

    private isolate(device: KseniaDevice, subsystem: 'HAP' | 'MQTT' | 'Matter', fn: () => void): void {
        runIsolated(this.deps.log, `${subsystem} handling of ${device.id}`, fn);
    }

    private addToHap(device: KseniaDevice): void {
        if (this.beyondHapLimit.has(device.id)) return;
        try {
            this.deps.accessoryRegistry.addAccessory(device);
        } catch (error: unknown) {
            const limit = error instanceof Error ? HAP_BRIDGE_LIMIT_ERROR.exec(error.message) : null;
            if (!limit) throw error;
            this.beyondHapLimit.add(device.id);
            if (this.beyondHapLimit.size === 1) {
                this.deps.log.warn(
                    `HomeKit (HAP) limit reached: a Homebridge bridge holds at most ${limit[1]} accessories, `
                    + `so ${device.name} (${device.id}) and the devices discovered after it are not added to HomeKit. `
                    + 'They are still exposed on Matter and published on MQTT. To bring them to HomeKit, '
                    + 'exclude devices you do not need (excludeZones, excludeOutputs, excludeSensors, excludeScenarios).',
                );
            } else {
                this.deps.log.debug(`Not added to HomeKit (bridge accessory limit): ${device.name} (${device.id})`);
            }
        }
    }
}
