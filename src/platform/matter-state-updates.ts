/**
 * Build Matter cluster state-update payloads from a Lares4 device.
 *
 * Pure functions, no side effects. Used by `MatterAccessoryRegistry` for both
 * the immediate-push and queue-for-flush paths.
 */

import type { KseniaDevice, KseniaThermostat } from '../types';
import {
    toCentidegrees,
    clampCentidegrees,
    luxToMatterIlluminance,
} from './matter-device-mapper';
import { buildThermostatMatterState } from './matter-thermostat-mapper';

export interface PendingMatterStateUpdate {
    clusterName: string;
    attributes: Record<string, unknown>;
    partId?: string;
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

    switch (device.type) {
        case 'light':
            out.push({ clusterName: 'onOff', attributes: { onOff: device.status.on } });
            if (device.status.dimmable && device.status.brightness !== undefined) {
                out.push({
                    clusterName: 'levelControl',
                    attributes: {
                        currentLevel: Math.max(1, Math.round((device.status.brightness / 100) * 254)),
                    },
                });
            }
            break;

        case 'cover': {
            const matterPos = Math.round((100 - (device.status.position ?? 0)) * 100);
            out.push({
                clusterName: 'windowCovering',
                attributes: {
                    currentPositionLiftPercent100ths: matterPos,
                    targetPositionLiftPercent100ths: matterPos,
                },
            });
            break;
        }

        case 'thermostat':
            if (thermostatAsFallback) {
                out.push({
                    clusterName: 'temperatureMeasurement',
                    attributes: { measuredValue: clampCentidegrees(toCentidegrees(device.currentTemperature ?? 21)) },
                });
            } else {
                const { base } = buildThermostatMatterState(device as KseniaThermostat);
                out.push({ clusterName: 'thermostat', attributes: base });
            }
            break;

        case 'sensor': {
            const val = device.status.value;
            switch (device.status.sensorType) {
                case 'temperature':
                    out.push({
                        clusterName: 'temperatureMeasurement',
                        attributes: { measuredValue: clampCentidegrees(toCentidegrees(val)) },
                    });
                    break;
                case 'humidity':
                    out.push({
                        clusterName: 'relativeHumidityMeasurement',
                        attributes: { measuredValue: Math.round(Math.max(0, Math.min(100, val)) * 100) },
                    });
                    break;
                case 'light':
                    out.push({
                        clusterName: 'illuminanceMeasurement',
                        attributes: { measuredValue: luxToMatterIlluminance(val) },
                    });
                    break;
                case 'motion':
                    out.push({
                        clusterName: 'occupancySensing',
                        attributes: { occupancy: { occupied: val > 0 } },
                    });
                    break;
                case 'contact':
                    out.push({
                        clusterName: 'booleanState',
                        attributes: { stateValue: val === 0 },
                    });
                    break;
            }
            break;
        }

        case 'zone':
            out.push({ clusterName: 'booleanState', attributes: { stateValue: !device.status.open } });
            break;

        case 'scenario':
            out.push({ clusterName: 'onOff', attributes: { onOff: device.status.active } });
            break;

        case 'gate':
            out.push({ clusterName: 'onOff', attributes: { onOff: device.status.on } });
            break;
    }

    return out;
}
