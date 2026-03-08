import type { API, Logger, PlatformAccessory } from 'homebridge';
import type { KseniaDevice } from '../types';
import type { AccessoryHandler } from './types';

interface AccessoryRegistryOptions {
    api: API;
    log: Logger;
    pluginName: string;
    platformName: string;
    accessories: Map<string, PlatformAccessory>;
    accessoryHandlers: Map<string, AccessoryHandler>;
    activeDiscoveredUUIDs: Set<string>;
    createAccessoryHandler: (
        accessory: PlatformAccessory,
        device: KseniaDevice,
    ) => AccessoryHandler | undefined;
    updateAccessoryHandler: (
        handler: AccessoryHandler,
        device: KseniaDevice,
    ) => void;
}

export class AccessoryRegistry {
    constructor(private readonly options: AccessoryRegistryOptions) {}

    public startDiscoveryCycle(): void {
        this.options.activeDiscoveredUUIDs.clear();
    }

    public configureAccessory(accessory: PlatformAccessory): void {
        this.options.log.info('Loading accessory from cache:', accessory.displayName);
        this.options.accessories.set(accessory.UUID, accessory);
    }

    public addAccessory(device: KseniaDevice): void {
        const uuid = this.options.api.hap.uuid.generate(device.id);
        this.options.activeDiscoveredUUIDs.add(uuid);
        const existingAccessory = this.options.accessories.get(uuid);

        if (existingAccessory) {
            this.options.log.info('Restoring existing accessory from cache:', device.name);
            existingAccessory.context.device = device;
            const existingHandler = this.options.accessoryHandlers.get(uuid);
            if (existingHandler) {
                this.options.updateAccessoryHandler(existingHandler, device);
            } else {
                const handler = this.options.createAccessoryHandler(existingAccessory, device);
                if (handler) {
                    this.options.accessoryHandlers.set(uuid, handler);
                }
            }
            return;
        }

        this.options.log.info('Adding new accessory:', device.name);
        const accessory = new this.options.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;

        const handler = this.options.createAccessoryHandler(accessory, device);
        if (handler) {
            this.options.accessoryHandlers.set(uuid, handler);
        }

        this.options.api.registerPlatformAccessories(
            this.options.pluginName,
            this.options.platformName,
            [accessory],
        );
        this.options.accessories.set(uuid, accessory);
    }

    public updateAccessory(device: KseniaDevice): void {
        const uuid = this.options.api.hap.uuid.generate(device.id);
        const accessory = this.options.accessories.get(uuid);
        const handler = this.options.accessoryHandlers.get(uuid);

        if (!accessory || !handler) {
            return;
        }

        accessory.context.device = device;
        this.options.updateAccessoryHandler(handler, device);
    }

    public pruneStaleAccessories(): void {
        for (const [uuid, accessory] of this.options.accessories) {
            if (!this.options.activeDiscoveredUUIDs.has(uuid)) {
                this.removeAccessory(accessory);
            }
        }
    }

    public removeAccessory(accessory: PlatformAccessory): void {
        this.options.log.info('Removing accessory:', accessory.displayName);
        const handler = this.options.accessoryHandlers.get(accessory.UUID);
        if (handler && 'dispose' in handler && typeof handler.dispose === 'function') {
            handler.dispose();
        }
        this.options.api.unregisterPlatformAccessories(
            this.options.pluginName,
            this.options.platformName,
            [accessory],
        );
        this.options.accessories.delete(accessory.UUID);
        this.options.accessoryHandlers.delete(accessory.UUID);
        this.options.activeDiscoveredUUIDs.delete(accessory.UUID);
    }
}
