/**
 * Registration attempts for a native Matter Thermostat (TH-01).
 *
 * Order: the conformant payload, then — only if the runtime did not create the
 * endpoint — the 2.2.0 payload, and only then the TemperatureSensor fallback.
 * Whether an attempt worked is decided by observing the endpoint (the probe),
 * never by the Homebridge version: on the bridged path Homebridge only logs a
 * refused endpoint and the register call resolves
 * (`homebridge/dist/matter/ChildBridgeMatterManager.js:56-60`).
 *
 * The registration/recovery code calls `nextThermostatAttempt` where it would
 * otherwise fall back, and `resetThermostatAttempts` when it does fall back.
 */

import type { MatterAccessory } from 'homebridge';
import type { KseniaDevice } from '../types';
import { buildThermostatMatterState } from './matter-thermostat-mapper';
import { setThermostatShape, thermostatShapeOf } from './matter-thermostat-shape';

/**
 * The accessory for the next attempt — same UUID, metadata and handlers, the
 * Thermostat cluster rebuilt with the next payload — or `undefined` when the
 * attempts are used up (or `accessory` is not a native Thermostat). From this
 * call on, every cluster built for the UUID (state updates included) has the
 * new payload's attribute set.
 */
export function nextThermostatAttempt(accessory: MatterAccessory): MatterAccessory | undefined {
    const device = accessory.context?.device as KseniaDevice | undefined;
    if (device?.type !== 'thermostat' || !accessory.clusters?.thermostat) return undefined;
    if (thermostatShapeOf(device.id) === 'legacy') return undefined;
    setThermostatShape(device.id, 'legacy');
    const { base, schemaInvariants } = buildThermostatMatterState(device);
    return { ...accessory, clusters: { ...accessory.clusters, thermostat: { ...base, ...schemaInvariants } } };
}

/** Back to the first attempt for `uuid` (after a fallback, or when the device goes away). */
export function resetThermostatAttempts(uuid: string): void {
    setThermostatShape(uuid, 'conformant');
}
