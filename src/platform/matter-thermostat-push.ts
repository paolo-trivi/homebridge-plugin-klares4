import type { KseniaDevice, KseniaThermostat } from '../types';
import type { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';
import { buildThermostatMatterState } from './matter-thermostat-mapper';

/**
 * The Thermostat attributes to push now. A queued update was built when it was
 * queued (the registration's first state, a realtime): by the time it is sent
 * the panel may have acknowledged a newer target or mode, and pushing the old
 * value would put a superseded state back on the endpoint (21 °C after the
 * panel confirmed 22). So the update is rebuilt from the latest snapshot,
 * with the values the panel acknowledged and the realtime has not reported yet
 * (the tracker's ledger, which the first realtime after the ACK ends).
 */
export function currentThermostatAttributes(
    device: KseniaDevice | undefined,
    queued: Record<string, unknown>,
    tracker: MatterThermostatEchoTracker,
): Record<string, unknown> {
    if (device?.type !== 'thermostat') return queued;
    const status = device.status;
    const observedTarget = status?.targetTemperature ?? device.targetTemperature;
    const observedMode = status?.mode ?? device.mode;
    const observation = { seq: status?.observedSeq, at: status?.observedAt };
    const target = tracker.effectiveTarget(device.id, observedTarget, observation) ?? observedTarget;
    const mode = tracker.effectiveMode(device.id, observedMode, observation) ?? observedMode;
    const view: KseniaThermostat = target === observedTarget && mode === observedMode
        ? device
        : { ...device, targetTemperature: target, mode, status: { ...status, targetTemperature: target, mode } };
    const { base } = buildThermostatMatterState(view, tracker.registeredRole(device.id));
    // Keep the queued update's attribute set (e.g. no running state when it was unknown).
    return Object.fromEntries(Object.keys(base).filter((key) => key in queued || key === 'thermostatRunningState').map((key) => [key, base[key]]));
}
