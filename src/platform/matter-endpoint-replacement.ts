import type { MatterAccessory } from 'homebridge';
import { registrationProbeCluster, type MatterTopologyCoordinator } from './matter-topology-coordinator';

/**
 * What the new endpoint is to controllers, compared with the one it replaces.
 *
 * - `same-device`: the same thing with the same function: a re-register of the
 *   same shape (stale-endpoint purge), another payload of the same device type
 *   (the second Thermostat attempt), a rename that could not happen in place,
 *   an OnOffLight that becomes a DimmableLight (a superset of it). The new
 *   endpoint gets the old `uniqueId` back, as Homebridge does in its own
 *   "changed structure" path (AccessoryManager.js:157-162), so controllers
 *   keep the device, its room and its automations.
 * - `other-device`: the function changes: a Thermostat replaced by its
 *   TemperatureSensor fallback (or the reverse). Keeping the identity would
 *   let a controller keep automations and scenes that set a temperature on
 *   what is now a read-only sensor, or treat a sensor as a thermostat; a new
 *   identity makes it show the accessory as new, which is what it is.
 */
export type ReplacementKind = 'same-device' | 'other-device';

export interface ReplaceableRegistration {
    uuid: string;
    matterAccessory: MatterAccessory;
    inheritedUniqueId?: string;
}

/**
 * Removes the endpoint of `reg` before a register of the same UUID: Homebridge
 * refuses a register of a UUID it still holds and only logs it, so the old
 * endpoint must be observed gone. Records the `uniqueId` the new endpoint
 * inherits (the registration flow gives it back once the endpoint answers);
 * across a chain of attempts the first endpoint's identity is the one kept.
 */
export async function replaceEndpoint(
    reg: ReplaceableRegistration,
    coordinator: MatterTopologyCoordinator,
    kind: ReplacementKind,
): Promise<void> {
    if (kind === 'same-device') reg.inheritedUniqueId ??= await coordinator.readUniqueId(reg.uuid);
    else reg.inheritedUniqueId = undefined;
    const removed = await coordinator.unregister(reg.uuid, registrationProbeCluster(reg.matterAccessory));
    if (!removed) throw new Error(`previous Matter endpoint for ${reg.uuid} is still present`);
}
