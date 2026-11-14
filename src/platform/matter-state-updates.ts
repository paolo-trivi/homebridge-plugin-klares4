/**
 * Build Matter cluster state-update payloads from a Lares4 device.
 *
 * Pure functions, no side effects. Used by `MatterAccessoryRegistry` for both
 * the immediate-push and queue-for-flush paths. A value that is not a valid
 * reading is left out, so the endpoint keeps the last valid one.
 */

import type { KseniaDevice, KseniaThermostat } from '../types';
import { buildThermostatMatterState } from './matter-thermostat-mapper';
import {
    coverLift, finiteNumber, humidityMeasuredValue, illuminanceMeasuredValue, levelFromBrightness, temperatureMeasuredValue,
} from './matter-value-guards';

export interface PendingMatterStateUpdate {
    clusterName: string;
    attributes: Record<string, unknown>;
    partId?: string;
}

/**
 * Merge the device's current state into a pending-update queue, deduping by
 * (clusterName, partId) so only the latest payload per cluster survives.
 */
export function mergeStateUpdates(
    pending: PendingMatterStateUpdate[],
    device: KseniaDevice,
    thermostatAsFallback: boolean,
    hasCluster: (clusterName: string) => boolean = () => true,
): void {
    for (const update of buildStateUpdates(device, thermostatAsFallback)) {
        if (!hasCluster(update.clusterName)) continue;
        const idx = pending.findIndex(
            (p) => p.clusterName === update.clusterName && p.partId === update.partId,
        );
        if (idx >= 0) pending[idx] = update;
        else pending.push(update);
    }
}

/**
 * Build the cluster-level updates representing the device's current state.
 *
 * @param device  Lares4 device snapshot
 * @param thermostatAsFallback  if true, push to `temperatureMeasurement` (used when
 *                              the Thermostat was registered as a TemperatureSensor fallback)
 */
export function buildStateUpdates(
    device: KseniaDevice,
    thermostatAsFallback = false,
): PendingMatterStateUpdate[] {
    const out: PendingMatterStateUpdate[] = [];
    const push = (clusterName: string, attributes: Record<string, unknown>): void => {
        const defined = Object.entries(attributes).filter(([, value]) => value !== undefined);
        if (defined.length > 0) out.push({ clusterName, attributes: Object.fromEntries(defined) });
    };

    switch (device.type) {
        case 'light':
            if (typeof device.status.on === 'boolean') push('onOff', { onOff: device.status.on });
            if (device.status.dimmable) push('levelControl', { currentLevel: levelFromBrightness(device.status.brightness) });
            break;

        case 'cover': {
            const { current, target } = coverLift(device.status);
            push('windowCovering', { currentPositionLiftPercent100ths: current, targetPositionLiftPercent100ths: target });
            break;
        }

        case 'thermostat':
            if (thermostatAsFallback) {
                push('temperatureMeasurement', { measuredValue: temperatureMeasuredValue(device.currentTemperature) });
            } else {
                const { base } = buildThermostatMatterState(device as KseniaThermostat);
                out.push({ clusterName: 'thermostat', attributes: base });
            }
            break;

        case 'sensor': {
            const val = device.status.value;
            const finite = finiteNumber(val);
            switch (device.status.sensorType) {
                case 'temperature':
                    push('temperatureMeasurement', { measuredValue: temperatureMeasuredValue(val) });
                    break;
                case 'humidity':
                    push('relativeHumidityMeasurement', { measuredValue: humidityMeasuredValue(val) });
                    break;
                case 'light':
                    push('illuminanceMeasurement', { measuredValue: illuminanceMeasuredValue(val) });
                    break;
                case 'motion':
                    if (finite !== undefined) push('occupancySensing', { occupancy: { occupied: finite > 0 } });
                    break;
                case 'contact':
                    if (finite !== undefined) push('booleanState', { stateValue: finite === 0 });
                    break;
            }
            break;
        }

        case 'zone':
            out.push({ clusterName: 'booleanState', attributes: { stateValue: !device.status.open } });
            break;

        case 'scenario':
            // Momentary trigger: state in Matter is always reported as off; the
            // mapper's `on` handler auto-resets after a short delay.
            out.push({ clusterName: 'onOff', attributes: { onOff: false } });
            break;

        case 'gate':
            // Momentary trigger: same pattern as scenarios.
            out.push({ clusterName: 'onOff', attributes: { onOff: false } });
            break;
    }

    return out;
}
