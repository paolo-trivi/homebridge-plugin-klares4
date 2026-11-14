/**
 * Last check on every value the plugin hands to matter.js. Out of range, a
 * value makes the whole registration fail (matter.js constraint validation)
 * and the endpoint stays absent for the session; NaN passes the validation
 * and reaches the controllers as a reading. Snapshots normally come
 * validated from the WebSocket layer, but `mergeKnownState` also fills them
 * from the Homebridge cache, written by older versions.
 *
 * Registration uses `null` (the "unknown" value of the nullable attributes)
 * where a value is missing; state updates skip it and keep the last one.
 */

import {
    toMatterTemperatureCelsius, clampMatterTemperature, TEMP_ABS_MIN_CENTI, TEMP_ABS_MAX_CENTI,
} from './matter-thermostat-mapper';

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 254;

/** The value when it is a finite number; strings, NaN and ±Infinity are not. */
export function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function clampCentidegrees(val: number): number {
    return clampMatterTemperature(val, TEMP_ABS_MIN_CENTI, TEMP_ABS_MAX_CENTI);
}

/** TemperatureMeasurement.measuredValue (0.01 °C) for a reading in °C. */
export function temperatureMeasuredValue(celsius: unknown): number | undefined {
    const value = finiteNumber(celsius);
    return value === undefined ? undefined : clampCentidegrees(toMatterTemperatureCelsius(value));
}

/** RelativeHumidityMeasurement.measuredValue (0.01 %) for a reading in %. */
export function humidityMeasuredValue(percent: unknown): number | undefined {
    const value = finiteNumber(percent);
    return value === undefined ? undefined : Math.round(clamp(value, 0, 100) * 100);
}

// Matter illuminance: measuredValue = 10000 * log10(lux) + 1  (Matter spec §2.2.5.1).
// Returns 0 for lux <= 0 (the spec uses 0 to mean "below the sensor's range").
export function luxToMatterIlluminance(lux: number): number {
    if (!Number.isFinite(lux) || lux <= 0) return 0;
    return clamp(Math.round(10000 * Math.log10(lux) + 1), 1, 65534);
}

/** IlluminanceMeasurement.measuredValue for a reading in lux. */
export function illuminanceMeasuredValue(lux: unknown): number | undefined {
    const value = finiteNumber(lux);
    return value === undefined ? undefined : luxToMatterIlluminance(value);
}

/** LevelControl.currentLevel (1..254; 0 is forbidden even when off) for a panel brightness in %. */
export function levelFromBrightness(percent: unknown): number | undefined {
    const value = finiteNumber(percent);
    return value === undefined ? undefined : clamp(Math.round((clamp(value, 0, 100) / 100) * MAX_LEVEL), MIN_LEVEL, MAX_LEVEL);
}

/** Matter lift (0 = open, 10000 = closed) for a panel position (0 = closed, 100 = open). */
export function liftPercent100ths(panelPosition: unknown): number | undefined {
    const value = finiteNumber(panelPosition);
    return value === undefined ? undefined : Math.round((100 - clamp(value, 0, 100)) * 100);
}

/**
 * The target must be the panel's own target (TPOS): matter.js derives
 * `operationalStatus` from target vs current, so a target equal to the current
 * position hides every movement from the controllers. No TPOS: the position.
 */
export function coverLift(status: { position?: unknown; targetPosition?: unknown } | undefined): {
    current: number | undefined;
    target: number | undefined;
} {
    const current = liftPercent100ths(status?.position);
    return { current, target: liftPercent100ths(status?.targetPosition) ?? current };
}
