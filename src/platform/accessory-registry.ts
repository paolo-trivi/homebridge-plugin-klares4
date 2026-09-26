import type { API, Logger, PlatformAccessory } from 'homebridge';
import { sanitizeHapDisplayName } from '../display-name';
import { hasObservedState, mergeKnownState } from '../device-observation';
import type { KseniaDevice } from '../types';
import {
    HAP_PRUNE_STALE_THRESHOLD_CYCLES,
    cachedDevice,
    discoveryFamily,
    readMissedCycles,
    writeMissedCycles,
} from './hap-prune-policy';
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
    /** Config exclusions: an excluded cached accessory is removed without waiting. */
    isDeviceExcluded?: (device: KseniaDevice) => boolean;
}

export class AccessoryRegistry {
    constructor(private readonly options: AccessoryRegistryOptions) {}

    public startDiscoveryCycle(): void {
        this.options.activeDiscoveredUUIDs.clear();
    }

    public configureAccessory(accessory: PlatformAccessory): void {
        this.options.log.info('Loading accessory from cache:', accessory.displayName);
        this.options.accessories.set(accessory.UUID, accessory);

        // Matter-readiness: the Matter bridge inspects accessories immediately at startup,
        // before the WS discovery cycle runs. Attach the handler now from cached context.
        const device = accessory.context?.device as KseniaDevice | undefined;
        if (!device || !device.id) {
            this.options.log.warn(
                `Skipping cache handler init for ${accessory.displayName}: missing device context`,
            );
            return;
        }

        // Legacy caches keep the invalid Name that HAP warns about at every publish.
        this.alignHapNames(accessory, device);
        const handler = this.options.createAccessoryHandler(accessory, device);
        if (handler) {
            this.options.accessoryHandlers.set(accessory.UUID, handler);
            this.options.log.debug(`Handler attached from cache for ${device.name}`);
        }
    }

    public addAccessory(device: KseniaDevice): void {
        const uuid = this.options.api.hap.uuid.generate(device.id);
        this.options.activeDiscoveredUUIDs.add(uuid);
        const existingAccessory = this.options.accessories.get(uuid);

        if (existingAccessory) {
            this.options.log.info('Restoring existing accessory from cache:', device.name);
            // Discovery placeholders must not overwrite the state cached from the last session.
            if (!hasObservedState(device)) device = mergeKnownState(device, existingAccessory.context.device as KseniaDevice);
            existingAccessory.context.device = device;
            this.alignHapNames(existingAccessory, device);
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
        // displayName must satisfy the HAP-NodeJS checkName rule; the raw panel
        // label stays available in context.device.name for domain consumers.
        const accessory = new this.options.api.platformAccessory(
            sanitizeHapDisplayName(device.name, device.id),
            uuid,
        );
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

    /**
     * Re-align every HAP name of a cached accessory with the sanitised device
     * name: displayName, AccessoryInformation Name and the primary service
     * Name. Covers panel renames and names cached before the HAP sanitiser
     * (e.g. "Balcone Sala " with a trailing space). The UUID is untouched.
     */
    private alignHapNames(accessory: PlatformAccessory, device: KseniaDevice): void {
        const cleanName = sanitizeHapDisplayName(device.name, device.id);
        if (accessory.displayName !== cleanName) {
            if (typeof accessory.updateDisplayName === 'function') {
                accessory.updateDisplayName(cleanName);
            } else {
                accessory.displayName = cleanName;
            }
        }
        const nameCharacteristic = this.options.api.hap.Characteristic?.Name;
        if (!nameCharacteristic) return;
        for (const service of accessory.services ?? []) {
            if (!service.testCharacteristic(nameCharacteristic)) continue;
            if (service.getCharacteristic(nameCharacteristic).value !== cleanName) {
                service.updateCharacteristic(nameCharacteristic, cleanName);
            }
        }
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

    /**
     * One prune pass per completed discovery sync (see `hap-prune-policy.ts`):
     * only accessories of a discovery family that answered in this sync are
     * candidates, and a candidate is removed after
     * `HAP_PRUNE_STALE_THRESHOLD_CYCLES` consecutive missed syncs. Accessories
     * excluded in the config are removed immediately.
     */
    public pruneStaleAccessories(): void {
        // Safety net: a sync that discovered NOTHING is a failed/partial sync
        // (WS glitch, panel busy), not a panel with zero devices. Removing every
        // cached accessory here would wipe HomeKit rooms/automations for the
        // whole bridge — skip and let the next complete sync prune for real.
        if (this.options.activeDiscoveredUUIDs.size === 0 && this.options.accessories.size > 0) {
            this.options.log.warn(
                'Skipping accessory prune: discovery returned no devices (partial or failed sync)',
            );
            return;
        }
        const answeredFamilies = this.answeredDiscoveryFamilies();
        const counterChanged: PlatformAccessory[] = [];
        let unanswered = 0;
        let waiting = 0;
        let removed = 0;

        for (const [uuid, accessory] of [...this.options.accessories]) {
            if (this.options.activeDiscoveredUUIDs.has(uuid)) {
                if (writeMissedCycles(accessory, 0)) counterChanged.push(accessory);
                continue;
            }
            const device = cachedDevice(accessory);
            if (device && this.options.isDeviceExcluded?.(device)) {
                this.removeAccessory(accessory);
                removed += 1;
                continue;
            }
            if (device && !answeredFamilies.has(discoveryFamily(device.id))) {
                unanswered += 1;
                continue;
            }
            const missed = readMissedCycles(accessory) + 1;
            if (missed < HAP_PRUNE_STALE_THRESHOLD_CYCLES) {
                writeMissedCycles(accessory, missed);
                counterChanged.push(accessory);
                waiting += 1;
                this.options.log.info(
                    `Missing accessory: ${accessory.displayName} — absent for ${missed}/`
                    + `${HAP_PRUNE_STALE_THRESHOLD_CYCLES} syncs, not removed yet`,
                );
                continue;
            }
            this.removeAccessory(accessory);
            removed += 1;
        }

        if (counterChanged.length > 0) {
            // Persist the counters with the cached accessories (survive a restart).
            this.options.api.updatePlatformAccessories?.(counterChanged);
        }
        if (unanswered > 0 || waiting > 0 || removed > 0) {
            this.options.log.info(
                `Accessory prune: removed=${removed} waiting=${waiting} `
                + `keptCategoryNotAnswered=${unanswered}`,
            );
        }
    }

    /** Discovery families with at least one device seen in this sync. */
    private answeredDiscoveryFamilies(): Set<string> {
        const families = new Set<string>();
        for (const uuid of this.options.activeDiscoveredUUIDs) {
            const accessory = this.options.accessories.get(uuid);
            const device = accessory ? cachedDevice(accessory) : undefined;
            if (device) families.add(discoveryFamily(device.id));
        }
        return families;
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
