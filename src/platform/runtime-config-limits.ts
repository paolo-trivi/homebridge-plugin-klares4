import type { NumberSpec } from './config-values';

/**
 * Numeric options with their limits and defaults, mirroring `config.schema.json`
 * (`test/runtime-config.test.js` fails when the two drift apart). Keys are the
 * dotted config paths. `port` and `mqtt.port` have no default on purpose: the
 * schema omits it, since a default would be written by the Homebridge UI even
 * with `https` off.
 */
export const NUMERIC_LIMITS = {
    port: { integer: true, min: 1, max: 65535, outOfRange: 'default' },
    logLevel: { integer: true, default: 1, oneOf: [0, 1, 2] },
    maxSeconds: { integer: true, default: 30, min: 5, max: 300 },
    reconnectInterval: { integer: true, default: 5000, min: 1000, max: 60000 },
    heartbeatInterval: { integer: true, default: 30000, min: 10000, max: 300000 },
    commandTimeoutMs: { integer: true, default: 8000, min: 1000, max: 30000 },
    coverStepSize: { integer: true, default: 5, min: 1, max: 20 },
    scenarioAutoOffDelay: { integer: true, default: 500, min: 100, max: 5000 },
    devicesSummaryDelay: { integer: true, default: 2000, min: 500, max: 10000 },
    matterUnregisterTimeoutMs: { integer: true, default: 3000, min: 500, max: 30000 },
    debugCaptureDurationMs: { integer: true, default: 60000, min: 10000, max: 1800000 },
    'temperatureDefaults.target': { integer: false, default: 21, min: 5, max: 35 },
    'temperatureDefaults.min': { integer: false, default: 10, min: 5, max: 20 },
    'temperatureDefaults.max': { integer: false, default: 38, min: 25, max: 40 },
    'temperatureDefaults.step': { integer: false, default: 0.5, oneOf: [0.5, 1] },
    'domusThermostat.sensorFreshnessMs': { integer: true, default: 300000, min: 30000, max: 3600000 },
    'mqtt.port': { integer: true, min: 1, max: 65535, outOfRange: 'default' },
    'mqtt.qos': { integer: true, default: 1, oneOf: [0, 1, 2] },
} as const satisfies Record<string, NumberSpec>;

export type NumericKey = keyof typeof NUMERIC_LIMITS;

/**
 * The spec of a key, typed so that `readNumber` knows whether a default exists.
 * (The `oneOf` tuples are readonly literals; `NumberSpec` accepts that.)
 */
export function limit<K extends NumericKey>(key: K): (typeof NUMERIC_LIMITS)[K] {
    return NUMERIC_LIMITS[key];
}
