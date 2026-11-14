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
 * The recovery path (`matter-registration-recovery.ts`) calls
 * `registerNextThermostatAttempt` where it would otherwise fall back, and
 * `resetThermostatAttempts` when it does fall back.
 */

import type { Logger, MatterAccessory } from 'homebridge';
import type { KseniaDevice } from '../types';
import type { MatterRegistration } from './matter-registration-recovery';
import type { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';
import { buildThermostatMatterState } from './matter-thermostat-mapper';
import { setThermostatShape, thermostatShapeOf } from './matter-thermostat-shape';
import { registrationProbeCluster, type MatterTopologyCoordinator } from './matter-topology-coordinator';

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

export interface ThermostatAttemptDeps {
    log: Logger;
    topologyCoordinator: MatterTopologyCoordinator;
    scheduleComplete: (uuid: string) => void;
    fmtErr: (err: unknown) => string;
    thermostatEchoTracker?: MatterThermostatEchoTracker;
}

/**
 * Registers the next Thermostat payload for a native registration that did
 * not come up (or whose register threw). `true` when the attempt is on its way
 * (the probe decides it); `false` when there is none left or it could not be
 * started, and the caller falls back.
 */
export async function registerNextThermostatAttempt(reg: MatterRegistration, deps: ThermostatAttemptDeps): Promise<boolean> {
    const next = nextThermostatAttempt(reg.matterAccessory);
    if (!next) return false;
    deps.log.warn(
        `[Matter] ${reg.displayName}: Homebridge did not create the Thermostat; `
        + 'trying the payload of earlier versions before falling back to TemperatureSensor.',
    );
    try {
        const removed = await deps.topologyCoordinator.unregister(reg.uuid, registrationProbeCluster(reg.matterAccessory));
        if (!removed) throw new Error(`previous Matter endpoint for ${reg.uuid} is still present`);
        // The register payload must not come back as a controller command.
        deps.thermostatEchoTracker?.recordPushed(reg.uuid, next.clusters?.thermostat as Record<string, unknown>);
        reg.matterAccessory = next;
        reg.status = 'pending';
        await deps.topologyCoordinator.register(next);
        reg.registeredDisplayName = next.displayName;
        deps.scheduleComplete(reg.uuid);
        return true;
    } catch (err) {
        deps.log.warn(`[Matter] ${reg.displayName}: second Thermostat attempt failed: ${deps.fmtErr(err)}`);
        return false;
    }
}
