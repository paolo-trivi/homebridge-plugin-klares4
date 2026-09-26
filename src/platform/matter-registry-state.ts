import type { MatterAccessory } from 'homebridge';
import type { KseniaDevice } from '../types';
import { hasAccessoryMetadataChanged } from './matter-device-mapper';
import type { MatterRegistration } from './matter-registration-recovery';
import { mergeStateUpdates } from './matter-state-updates';

/**
 * Records the latest snapshot on the registration (handlers read it from
 * there) and queues its state for the clusters the registered endpoint really
 * has. A light that turns out to dim still sits on an OnOffLight endpoint
 * until the upgrade re-registers it: a LevelControl write there makes
 * `endpoint.set` throw inside Homebridge, and nobody sees the failure.
 */
export function enqueueDeviceState(reg: MatterRegistration, device: KseniaDevice, thermostatAsFallback: boolean): void {
    reg.matterAccessory.context.device = device;
    const clusters = reg.matterAccessory.clusters ?? {};
    mergeStateUpdates(reg.pendingStateUpdates, device, thermostatAsFallback, (name) => name in clusters);
}

/**
 * A re-mapping only refreshes the accessory's identity fields. Clusters,
 * device type and handlers describe the live endpoint and change only through
 * a re-registration; taking them from a re-mapping made the registry believe
 * the endpoint had clusters it does not have (e.g. LevelControl on an
 * OnOffLight, which also disabled the dimmer upgrade).
 */
export function refreshRegistrationMetadata(reg: MatterRegistration, mapped: MatterAccessory): boolean {
    if (!hasAccessoryMetadataChanged(reg.matterAccessory, mapped)) return false;
    reg.matterAccessory = {
        ...reg.matterAccessory,
        displayName: mapped.displayName,
        manufacturer: mapped.manufacturer,
        model: mapped.model,
        serialNumber: mapped.serialNumber,
        firmwareRevision: mapped.firmwareRevision,
    };
    reg.displayName = mapped.displayName;
    return true;
}
