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
 * inherits: the coordinator applies it within the next register of the UUID,
 * and the registration flow checks it again once the endpoint answers. Across
 * a chain of attempts the first endpoint's identity is the one kept.
 */
/**
 * The endpoint registered next under `reg.uuid` takes `uniqueId` (an identity
 * kept from an earlier endpoint of the same device, e.g. the sensor a
 * Thermostat recovery removed), applied with the register like the one
 * `replaceEndpoint` records.
 */
export function inheritIdentity(
    reg: ReplaceableRegistration,
    coordinator: MatterTopologyCoordinator,
    uniqueId: string | undefined,
): void {
    reg.inheritedUniqueId = uniqueId;
    coordinator.inheritOnNextRegister(reg.uuid, uniqueId);
}

export async function replaceEndpoint(
    reg: ReplaceableRegistration,
    coordinator: MatterTopologyCoordinator,
    kind: ReplacementKind,
): Promise<void> {
    if (kind === 'same-device') {
        reg.inheritedUniqueId ??= await coordinator.readUniqueId(reg.uuid);
        // Typical of a purge: the endpoint is replaced because it does not answer.
        if (!reg.inheritedUniqueId) coordinator.reportIdentityUnavailable(reg.uuid);
    } else {
        reg.inheritedUniqueId = undefined;
    }
    const removed = await coordinator.unregister(reg.uuid, registrationProbeCluster(reg.matterAccessory));
    if (!removed) throw new Error(`previous Matter endpoint for ${reg.uuid} is still present`);
    // Applied by the register that follows, before anything can see the new endpoint.
    coordinator.inheritOnNextRegister(reg.uuid, reg.inheritedUniqueId);
}
