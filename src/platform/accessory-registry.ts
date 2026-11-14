import type { API, Logger, PlatformAccessory } from 'homebridge';
import { sanitizeHapDisplayName } from '../display-name';
import { hasObservedState, mergeKnownState } from '../device-observation';
import type { KseniaDevice } from '../types';
import { errorDetail } from '../isolation';
import {
    HAP_PRUNE_STALE_THRESHOLD_CYCLES,
    cachedDevice,
    readMissedCycles,
    writeMissedCycles,
} from './hap-prune-policy';
import { belowDiscoveryFloor, discoveryFamily, familiesOf, type SyncOutcome } from './prune-policy';
import type { AccessoryHandler } from './types';

/** What one HAP prune pass is told about the sync it closes. */
export interface HapPruneContext extends Partial<SyncOutcome> {
    /** Devices hidden by the panel-side policy (suppressed scenarios): removed like excluded ones. */
    isHiddenByPolicy?: (device: KseniaDevice) => boolean;
}

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

    /**
     * Homebridge calls this for every cached accessory without catching: a
     * throw here would stop the restore of the whole cache at every start.
     */
    public configureAccessory(accessory: PlatformAccessory): void {
        this.options.log.info('Loading accessory from cache:', accessory.displayName);
        this.options.accessories.set(accessory.UUID, accessory);

        // Matter-readiness: the Matter bridge inspects accessories immediately at startup,
        // before the WS discovery cycle runs. Attach the handler now from cached context.
        const device = usableCachedDevice(accessory);
        if (!device) {
            this.options.log.warn(
                `Skipping cache handler init for ${accessory.displayName}: missing or malformed device context `
                + '(the accessory is realigned at the next discovery)',
            );
            return;
        }
        // Excluded: removed at the end of the first sync, never commandable meanwhile.
        if (this.options.isDeviceExcluded?.(device)) return;

        try {
            // Legacy caches keep the invalid Name that HAP warns about at every publish.
            this.alignHapNames(accessory, device);
            const handler = this.options.createAccessoryHandler(accessory, device);
            if (handler) {
                this.options.accessoryHandlers.set(accessory.UUID, handler);
                this.options.log.debug(`Handler attached from cache for ${device.name}`);
            }
        } catch (error: unknown) {
            this.options.log.warn(
                `Skipping cache handler init for ${accessory.displayName} (${device.id}): ${errorDetail(error)}`,
            );
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

        // The services must exist before HAP publishes the accessory, but the
        // handler is kept only once Homebridge has accepted it (the bridge
        // refuses accessories beyond its limit by throwing).
        const handler = this.options.createAccessoryHandler(accessory, device);
        try {
            this.options.api.registerPlatformAccessories(
                this.options.pluginName,
                this.options.platformName,
                [accessory],
            );
        } catch (error: unknown) {
            if (handler) disposeHandler(handler);
            throw error;
        }
        if (handler) this.options.accessoryHandlers.set(uuid, handler);
        this.options.accessories.set(uuid, accessory);
    }

    /**
     * Re-align every HAP name of a cached accessory with the sanitised device
     * name: displayName, AccessoryInformation Name and the primary service
     * Name. Covers panel renames and names cached before the HAP sanitiser
     * (e.g. "Living Room " with a trailing space). The UUID is untouched.
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
     * One prune pass per completed discovery sync, with the discipline of
     * `prune-policy.ts`. `answeredFamilies` comes from the sync lifecycle (every
     * device the panel listed, whatever its exposure); without it the families
     * are taken from the accessories seen in this cycle. Accessories excluded
     * in the config or hidden by the scenario policy are removed immediately.
     */
    public pruneStaleAccessories(context: HapPruneContext = {}): void {
        const { accessories, activeDiscoveredUUIDs } = this.options;
        const hidden = (device: KseniaDevice | undefined): boolean => !!device
            && (!!this.options.isDeviceExcluded?.(device) || !!context.isHiddenByPolicy?.(device));
        let removed = 0;
        for (const accessory of [...accessories.values()]) {
            if (activeDiscoveredUUIDs.has(accessory.UUID) || !hidden(cachedDevice(accessory))) continue;
            this.removeAccessory(accessory);
            removed += 1;
        }

        const known = accessories.size;
        if (belowDiscoveryFloor(activeDiscoveredUUIDs.size, known)) {
            this.options.log.warn(
                `Skipping accessory prune: discovery returned ${activeDiscoveredUUIDs.size} of ${known} `
                + 'accessories (partial or failed sync)',
            );
            return;
        }
        const answeredFamilies = context.answeredFamilies ?? this.familiesSeenInCycle();
        const counterChanged: PlatformAccessory[] = [];
        let unanswered = 0;
        let waiting = 0;

        for (const [uuid, accessory] of [...accessories]) {
            if (activeDiscoveredUUIDs.has(uuid)) {
                if (writeMissedCycles(accessory, 0)) counterChanged.push(accessory);
                continue;
            }
            const device = cachedDevice(accessory);
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

    /** Discovery families with at least one accessory seen in this cycle. */
    private familiesSeenInCycle(): Set<string> {
        const ids: string[] = [];
        for (const uuid of this.options.activeDiscoveredUUIDs) {
            const accessory = this.options.accessories.get(uuid);
            const device = accessory ? cachedDevice(accessory) : undefined;
            if (device) ids.push(device.id);
        }
        return familiesOf(ids);
    }

    public removeAccessory(accessory: PlatformAccessory): void {
        this.options.log.info('Removing accessory:', accessory.displayName);
        const handler = this.options.accessoryHandlers.get(accessory.UUID);
        if (handler) disposeHandler(handler);
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

function disposeHandler(handler: AccessoryHandler): void {
    if ('dispose' in handler && typeof handler.dispose === 'function') handler.dispose();
}

/** The cached device snapshot, if it has the shape every accessory handler reads. */
function usableCachedDevice(accessory: PlatformAccessory): KseniaDevice | undefined {
    const device = cachedDevice(accessory);
    if (!device || typeof device.type !== 'string' || typeof device.name !== 'string') return undefined;
    const status: unknown = device.status;
    return status !== null && typeof status === 'object' ? device : undefined;
}
