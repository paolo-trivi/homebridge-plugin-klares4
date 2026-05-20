/**
 * Matter Thermostat mapping helpers.
 *
 * Isolates all Thermostat-specific logic: temperature conversions, default ranges,
 * deadband enforcement, system-mode mapping, and the presetTypes workaround
 * required by matter.js 0.17 (see comment on `getThermostatPresetWorkaroundAttributes`).
 *
 * Pure functions only — no side effects, no I/O — to keep the unit tests trivial.
 */

import type { KseniaThermostat } from '../types';

// ---------------------------------------------------------------------------
// Constants (Matter spec §4.3 + sensible defaults for residential heating systems)
// ---------------------------------------------------------------------------

export const DEFAULT_MIN_HEAT_C = 5;
export const DEFAULT_MAX_HEAT_C = 30;
export const DEFAULT_MIN_COOL_C = 16;
export const DEFAULT_MAX_COOL_C = 35;
export const DEFAULT_DEADBAND_C = 2;
export const DEFAULT_HEATING_SETPOINT_C = 20;
export const DEFAULT_COOLING_SETPOINT_C = 24;
export const DEFAULT_LOCAL_TEMPERATURE_C = 20;

// Matter temperature attribute hard limits (int16, centidegrees)
export const TEMP_ABS_MIN_CENTI = -27000; // −270.00 °C
export const TEMP_ABS_MAX_CENTI = 10000;  //  100.00 °C

// ControlSequenceOfOperationEnum (Matter spec §4.3.7.30)
export const CONTROL_SEQ_HEATING_ONLY = 2;
export const CONTROL_SEQ_COOLING_AND_HEATING = 4;

// SystemModeEnum (Matter spec §4.3.7.32)
export const SYSTEM_MODE_OFF = 0;
export const SYSTEM_MODE_AUTO = 1;
export const SYSTEM_MODE_COOL = 3;
export const SYSTEM_MODE_HEAT = 4;

// PresetScenarioEnum (Matter spec §4.3.8.16)
export const PRESET_SCENARIO_OCCUPIED = 1;

// ---------------------------------------------------------------------------
// Temperature helpers
// ---------------------------------------------------------------------------

/**
 * Convert °C to Matter centidegrees (int16, factor 100).
 * Coerces strings, rejects NaN/null/undefined returning the provided fallback.
 */
export function toMatterTemperatureCelsius(value: unknown, fallbackC = 0): number {
    const n = coerceToFiniteNumber(value);
    if (n === undefined) return Math.round(fallbackC * 100);
    return Math.round(n * 100);
}

/** Convert Matter centidegrees back to °C. */
export function fromMatterTemperatureCelsius(value: number): number {
    return value / 100;
}

/** Clamp a Matter-encoded temperature to the supplied (centidegree) bounds. */
export function clampMatterTemperature(valueCenti: number, minCenti: number, maxCenti: number): number {
    if (Number.isNaN(valueCenti)) return minCenti;
    return Math.max(minCenti, Math.min(maxCenti, valueCenti));
}

function coerceToFiniteNumber(value: unknown): number | undefined {
    if (value === null || value === undefined) return undefined;
    const n = typeof value === 'string' ? Number(value) : (value as number);
    return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// SystemMode / ControlSequenceOfOperation
// ---------------------------------------------------------------------------

export type DomainThermostatMode = 'off' | 'heat' | 'cool' | 'auto';

export function domainModeToMatterSystemMode(mode: DomainThermostatMode | undefined): number {
    switch (mode) {
        case 'heat': return SYSTEM_MODE_HEAT;
        case 'cool': return SYSTEM_MODE_COOL;
        case 'auto': return SYSTEM_MODE_AUTO;
        default:     return SYSTEM_MODE_OFF;
    }
}

// ---------------------------------------------------------------------------
// Preset workaround (matter.js 0.17 quirk)
// ---------------------------------------------------------------------------

/**
 * matter.js 0.17 alpha applies the Presets-feature schema validation to the
 * Thermostat cluster even when the device type is composed without the Presets
 * feature, so `presetTypes` must be present with at least one entry. The
 * `presetTypeFeatures` field is a bitmap and must be passed as an object —
 * matter.js's BitmapManager rejects raw numbers ("Cannot manage number because
 * it is not a bitmap object").
 *
 * Tracking: https://github.com/project-chip/matter.js/issues (search "presetTypes")
 */
export function getThermostatPresetWorkaroundAttributes(): Record<string, unknown> {
    return {
        numberOfPresets: 1,
        presetTypes: [
            {
                presetScenario: PRESET_SCENARIO_OCCUPIED,
                numberOfPresets: 1,
                presetTypeFeatures: { automatic: false, supportsNames: false },
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// Handler helpers — used by mapThermostat command handlers
// ---------------------------------------------------------------------------

/**
 * Map a Matter SystemMode value (Matter spec §4.3.7.32) back to a klares4 domain mode.
 * Returns null for modes the device does not support (e.g. Cool/Auto on a heating-only
 * thermostat) so callers can log a warning and skip the command instead of crashing.
 */
export function matterSystemModeToKlares4Mode(
    matterMode: number,
    supportsCooling: boolean,
): DomainThermostatMode | null {
    switch (matterMode) {
        case SYSTEM_MODE_OFF:  return 'off';
        case SYSTEM_MODE_HEAT: return 'heat';
        case SYSTEM_MODE_COOL: return supportsCooling ? 'cool' : null;
        case SYSTEM_MODE_AUTO: return supportsCooling ? 'auto' : null;
        default:               return null;
    }
}

/**
 * Convert a Matter setpoint (centidegrees) to °C, clamped to [minC, maxC].
 * Returns the (possibly clamped) value and a flag indicating whether clamping occurred.
 */
export function normalizeMatterSetpointC(
    centidegrees: number,
    minC: number,
    maxC: number,
): { value: number; clamped: boolean } {
    const raw = fromMatterTemperatureCelsius(centidegrees);
    const value = Math.max(minC, Math.min(maxC, raw));
    return { value, clamped: value !== raw };
}

// ---------------------------------------------------------------------------
// Capability detection (heuristic — Lares4 zone names follow Italian conventions)
// ---------------------------------------------------------------------------

/**
 * Decide whether a Lares4 thermostat should expose Matter cooling.
 * The Lares4 system itself does not expose this metadata in the WS payload,
 * but the standard installer naming convention is "Riscaldamento_*" for heating-only
 * and "Raffrescamento_*" / "Climatizzazione_*" for HVAC with cooling.
 *
 * Heuristic only — when in doubt we default to HeatingOnly (more restrictive,
 * less likely to surprise users with a fake cooling slider).
 */
export function thermostatSupportsCooling(device: KseniaThermostat): boolean {
    const name = device.name?.toLowerCase() ?? '';
    return name.includes('raffrescamento')
        || name.includes('raffreddamento')
        || name.includes('climatizzazione')
        || name.includes('cooling')
        || name.includes('cool');
}

// ---------------------------------------------------------------------------
// Full Thermostat attribute payload (centralised — used by both register and update flows)
// ---------------------------------------------------------------------------

export interface ThermostatMatterState {
    /** Mandatory Thermostat attributes used at register time and on every state update. */
    base: Record<string, unknown>;
    /** Static schema-mandated attributes (limits, deadband, preset workaround) — register-time only. */
    schemaInvariants: Record<string, unknown>;
}

/**
 * Build the full Thermostat cluster state for a Lares4 thermostat.
 *
 * The Homebridge 2 Thermostat device type enables HEAT + COOL + AUTO + OCC features
 * (see `node_modules/homebridge/dist/matter/types.js`). All mandatory attributes for
 * these features must be present at register time. Updates pushed via
 * `api.matter.updateAccessoryState(...)` only need the dynamic subset (`base`).
 *
 * @param device Lares4 thermostat device
 */
export function buildThermostatMatterState(device: KseniaThermostat): ThermostatMatterState {
    // Convert + clamp to absolute Matter bounds, with safe fallbacks for null/undefined/NaN.
    const localTempC = coerceToFiniteNumber(device.currentTemperature) ?? DEFAULT_LOCAL_TEMPERATURE_C;
    const heatingTargetC = coerceToFiniteNumber(device.targetTemperature) ?? DEFAULT_HEATING_SETPOINT_C;

    const heatMinCenti = Math.round(DEFAULT_MIN_HEAT_C * 100);
    const heatMaxCenti = Math.round(DEFAULT_MAX_HEAT_C * 100);
    const coolMinCenti = Math.round(DEFAULT_MIN_COOL_C * 100);
    const coolMaxCenti = Math.round(DEFAULT_MAX_COOL_C * 100);
    const deadbandCenti = Math.round(DEFAULT_DEADBAND_C * 100);

    const localTempCenti = clampMatterTemperature(toMatterTemperatureCelsius(localTempC), TEMP_ABS_MIN_CENTI, TEMP_ABS_MAX_CENTI);
    const heatingSetpointCenti = clampMatterTemperature(toMatterTemperatureCelsius(heatingTargetC), heatMinCenti, heatMaxCenti);

    // AUTO-feature invariant: occupiedCoolingSetpoint - occupiedHeatingSetpoint >= minSetpointDeadBand.
    // If the natural cooling default would violate this, push it up to heating + deadband.
    const coolingTargetCenti = clampMatterTemperature(
        Math.max(Math.round(DEFAULT_COOLING_SETPOINT_C * 100), heatingSetpointCenti + deadbandCenti),
        coolMinCenti,
        coolMaxCenti,
    );

    // If after clamping the cool side, the gap is still smaller than the deadband
    // (only possible at the very top of the cooling range), drag heating down instead.
    const enforcedHeatingSetpointCenti = (coolingTargetCenti - heatingSetpointCenti < deadbandCenti)
        ? Math.max(heatMinCenti, coolingTargetCenti - deadbandCenti)
        : heatingSetpointCenti;

    const supportsCooling = thermostatSupportsCooling(device);
    const controlSequence = supportsCooling
        ? CONTROL_SEQ_COOLING_AND_HEATING
        : CONTROL_SEQ_HEATING_ONLY;

    // The Homebridge bundled device type still ships the HEAT+COOL+AUTO+OCC features.
    // Even on a heating-only Lares4 zone, omitting cooling attributes will violate the
    // cluster schema. We ship them anyway with sane values but set the control sequence
    // so HomeKit/Matter clients understand which modes are meaningful.

    const systemMode = domainModeToMatterSystemMode(device.mode);
    // When ControlSequence is HeatingOnly, valid SystemMode values are {Off, Heat}.
    // Coerce cool/auto → heat so the cluster invariant holds.
    const coerencedSystemMode = (!supportsCooling && (systemMode === SYSTEM_MODE_COOL || systemMode === SYSTEM_MODE_AUTO))
        ? SYSTEM_MODE_HEAT
        : systemMode;

    const base: Record<string, unknown> = {
        localTemperature: localTempCenti,
        occupiedHeatingSetpoint: enforcedHeatingSetpointCenti,
        occupiedCoolingSetpoint: coolingTargetCenti,
        unoccupiedHeatingSetpoint: enforcedHeatingSetpointCenti,
        unoccupiedCoolingSetpoint: coolingTargetCenti,
        systemMode: coerencedSystemMode,
    };

    const schemaInvariants: Record<string, unknown> = {
        absMinHeatSetpointLimit: heatMinCenti,
        absMaxHeatSetpointLimit: heatMaxCenti,
        minHeatSetpointLimit: heatMinCenti,
        maxHeatSetpointLimit: heatMaxCenti,
        absMinCoolSetpointLimit: coolMinCenti,
        absMaxCoolSetpointLimit: coolMaxCenti,
        minCoolSetpointLimit: coolMinCenti,
        maxCoolSetpointLimit: coolMaxCenti,
        minSetpointDeadBand: Math.round(DEFAULT_DEADBAND_C * 10), // int8s in tenths of °C
        controlSequenceOfOperation: controlSequence,
        ...getThermostatPresetWorkaroundAttributes(),
    };

    return { base, schemaInvariants };
}

// ---------------------------------------------------------------------------
// Echo-suppression guard for Matter attribute-change handlers
// ---------------------------------------------------------------------------

/**
 * Prevents feedback loops when Matter attribute-change handlers send commands to
 * Lares4, which then echoes the change back as a state update: the plugin pushes
 * the update via `api.matter.updateAccessoryState`, which writes the Matter attribute,
 * which re-fires the handler — an infinite loop.
 *
 * Usage: call `record(key, centi)` immediately before sending a command; the handler
 * checks `isEcho(key, centi)` first and returns early if the invocation is an echo.
 */
export class ThermostatEchoGuard {
    private readonly sent = new Map<string, { centi: number; time: number }>();
    private readonly ttlMs: number;
    constructor(ttlMs = 8000) { this.ttlMs = ttlMs; }
    record(key: string, centi: number): void { this.sent.set(key, { centi, time: Date.now() }); }
    isEcho(key: string, centi: number): boolean {
        const s = this.sent.get(key);
        return !!s && s.centi === centi && (Date.now() - s.time) < this.ttlMs;
    }
}
