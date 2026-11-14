/**
 * Registration attempts for a native Matter Thermostat (TH-01).
 *
 * Order: the payload that last worked for the device (remembered by the
 * fallback store, see `startThermostatAttempts`), else the conformant one;
 * then — only if the runtime did not create the endpoint — the other payload,
 * and only then the TemperatureSensor fallback.
 * Whether an attempt worked is decided by observing the endpoint (the probe),
 * never by the Homebridge version: on the bridged path Homebridge only logs a
 * refused endpoint and the register call resolves
 * (`homebridge/dist/matter/ChildBridgeMatterManager.js:56-60`).
 *
 * The recovery path (`matter-registration-recovery.ts`) calls
 * `registerNextThermostatAttempt` where it would otherwise fall back, and
 * `resetThermostatAttempts` when it does fall back. A registered Thermostat
 * whose cluster no longer matches the device (its output role became known or
 * changed) is replaced in place by `reshapeThermostatEndpoint`.
 */

import type { Logger, MatterAccessory } from 'homebridge';
import type { KseniaDevice, KseniaThermostat } from '../types';
import type { MatterRegistration } from './matter-registration-recovery';
import type { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';
import { buildThermostatMatterState } from './matter-thermostat-mapper';
import { advanceThermostatShape, resetThermostatShapes, startThermostatShapes, type ThermostatShape } from './matter-thermostat-shape';
import { replaceEndpoint } from './matter-endpoint-replacement';
import type { MatterTopologyCoordinator } from './matter-topology-coordinator';

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
    if (!advanceThermostatShape(device.id)) return undefined;
    const { base, schemaInvariants } = buildThermostatMatterState(device);
    return { ...accessory, clusters: { ...accessory.clusters, thermostat: { ...base, ...schemaInvariants } } };
}

/**
 * First registration of `uuid` by a registry: the attempts start from the
 * payload that worked last time, so a runtime that only takes the second one
 * is not refused again at every start. A remembered payload that the runtime
 * now refuses (Homebridge updated) moves on to the other one by itself.
 */
export function startThermostatAttempts(uuid: string, remembered: ThermostatShape | undefined): void {
    startThermostatShapes(uuid, remembered);
}

/** Back to the first attempt for `uuid` (after a fallback, or when the device goes away). */
export function resetThermostatAttempts(uuid: string): void {
    resetThermostatShapes(uuid);
}

/**
 * Static attribute set of a Thermostat cluster: which attributes it declares
 * (the features Homebridge derives from them) and its control sequence. State
 * values do not count.
 */
function clusterSignature(cluster: Record<string, unknown> | undefined): string {
    if (!cluster) return '';
    return `${Object.keys(cluster).sort().join(',')}|${String(cluster.controlSequenceOfOperation)}`;
}

/**
 * True when the live Thermostat endpoint no longer has the attribute set the
 * device needs now: the output's role became known after the registration
 * (first login, program data read after the outputs) or changed on the panel.
 */
export function needsThermostatReshape(registered: MatterAccessory, device: KseniaDevice): boolean {
    if (device.type !== 'thermostat') return false;
    const live = registered.clusters?.thermostat as Record<string, unknown> | undefined;
    if (!live) return false;
    const { base, schemaInvariants } = buildThermostatMatterState(device);
    return clusterSignature(live) !== clusterSignature({ ...base, ...schemaInvariants });
}

const failedReshapes = new WeakSet<MatterRegistration>();

/**
 * Removes the endpoint of a registered Thermostat whose role changed, keeping
 * its identity (`same-device`: the same output, still a thermostat), so the
 * caller can register the new shape. `false` when the old endpoint could not
 * be removed: the registration stays as it is and is not tried again.
 */
export async function reshapeThermostatEndpoint(
    reg: MatterRegistration,
    device: KseniaThermostat,
    deps: Pick<ThermostatAttemptDeps, 'log' | 'topologyCoordinator' | 'fmtErr'>,
): Promise<boolean> {
    if (failedReshapes.has(reg)) return false;
    deps.log.info(`[Matter] ${device.name}: the output's role in its thermostat program is now known or changed; replacing the Thermostat endpoint (identity kept)`);
    try {
        await replaceEndpoint(reg, deps.topologyCoordinator, 'same-device');
        return true;
    } catch (err) {
        failedReshapes.add(reg);
        deps.log.warn(`[Matter] ${device.name} keeps its previous Thermostat endpoint: ${deps.fmtErr(err)}`);
        return false;
    }
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
        // Still a Thermostat: the new endpoint keeps the identity of the refused one, if it had one.
        await replaceEndpoint(reg, deps.topologyCoordinator, 'same-device');
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
