/**
 * Matter Thermostat mapping helpers.
 *
 * Isolates all Thermostat-specific logic: temperature conversions, default ranges,
 * deadband enforcement, system-mode mapping and the cluster payload, whose
 * attribute set follows the output's role (`matter-thermostat-role.ts`) and
 * the registration shape (`matter-thermostat-shape.ts`).
 *
 * No I/O; the only state read is the per-UUID shape choice.
 */

import type { KseniaThermostat, ThermostatOutputRole } from '../types';
import { isRoleInSeason, thermostatRole, thermostatRunningState } from './matter-thermostat-role';
import { getThermostatPresetWorkaroundAttributes, thermostatShapeOf } from './matter-thermostat-shape';

export { getThermostatPresetWorkaroundAttributes, PRESET_SCENARIO_OCCUPIED } from './matter-thermostat-shape';

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
export const CONTROL_SEQ_COOLING_ONLY = 0;
export const CONTROL_SEQ_HEATING_ONLY = 2;
export const CONTROL_SEQ_COOLING_AND_HEATING = 4;

// SystemModeEnum (Matter spec §4.3.7.32)
export const SYSTEM_MODE_OFF = 0;
export const SYSTEM_MODE_AUTO = 1;
export const SYSTEM_MODE_COOL = 3;
export const SYSTEM_MODE_HEAT = 4;

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

/**
 * Map a Matter SystemMode to the domain mode for an endpoint of `role`: Heat
 * only on a heating output, Cool only on a cooling one, Auto only on an output
 * that does both. `null` for anything else.
 */
export function matterSystemModeForRole(matterMode: number, role: ThermostatOutputRole): DomainThermostatMode | null {
    if (matterMode === SYSTEM_MODE_OFF) return 'off';
    if (matterMode === SYSTEM_MODE_HEAT && role !== 'cooling') return 'heat';
    if (matterMode === SYSTEM_MODE_COOL && role !== 'heating') return 'cool';
    if (matterMode === SYSTEM_MODE_AUTO && role === 'heating-cooling') return 'auto';
    return null;
}

// ---------------------------------------------------------------------------
// Capability (from the output's role, see matter-thermostat-role.ts)
// ---------------------------------------------------------------------------

/** True when the endpoint declares cooling: a cooling output, or one that does both. */
export function thermostatSupportsCooling(device: KseniaThermostat): boolean {
    return thermostatRole(device) !== 'heating';
}

/**
 * The single Lares4 target is the cooling setpoint only in cool mode on a
 * cooling-capable zone; otherwise it is the heating setpoint.
 */
export function isCoolingSetpointActive(supportsCooling: boolean, mode: DomainThermostatMode | undefined): boolean {
    return supportsCooling && mode === 'cool';
}

/** True when the panel's single target is this endpoint's cooling setpoint. */
export function isCoolingSetpointActiveForRole(role: ThermostatOutputRole, mode: DomainThermostatMode | undefined): boolean {
    if (role === 'heating-cooling') return mode === 'cool';
    return role === 'cooling';
}

const modeOf = (d: KseniaThermostat): DomainThermostatMode | undefined => d.status?.mode ?? d.mode;

/**
 * The systemMode an endpoint shows. An output that does one thing shows its
 * own mode (Heat or Cool) only while the program runs in its season, and Off
 * otherwise: its relay is not the one the program drives.
 */
export function thermostatSystemModeFor(role: ThermostatOutputRole, device: KseniaThermostat): number {
    const mode = modeOf(device);
    if (role === 'heating-cooling') return domainModeToMatterSystemMode(mode);
    if (mode === undefined || mode === 'off' || !isRoleInSeason(role, device)) return SYSTEM_MODE_OFF;
    return role === 'heating' ? SYSTEM_MODE_HEAT : SYSTEM_MODE_COOL;
}

// ---------------------------------------------------------------------------
// Full Thermostat attribute payload (centralised — used by both register and update flows)
// ---------------------------------------------------------------------------

export interface ThermostatMatterState {
    /** Attributes that follow the device state: sent at register time and on every state update. */
    base: Record<string, unknown>;
    /** Static attributes (limits, deadband, control sequence) — register-time only. */
    schemaInvariants: Record<string, unknown>;
}

const HEAT_MIN_CENTI = Math.round(DEFAULT_MIN_HEAT_C * 100);
const HEAT_MAX_CENTI = Math.round(DEFAULT_MAX_HEAT_C * 100);
const COOL_MIN_CENTI = Math.round(DEFAULT_MIN_COOL_C * 100);
const COOL_MAX_CENTI = Math.round(DEFAULT_MAX_COOL_C * 100);
const DEADBAND_CENTI = Math.round(DEFAULT_DEADBAND_C * 100);

/** Both setpoints, kept a deadband apart as AutoMode requires (cooling − heating ≥ deadband). */
function pairedSetpoints(coolActive: boolean, targetC: number): { heat: number; cool: number } {
    if (coolActive) {
        // The target is the cooling setpoint; heating sits at least a deadband
        // below it (always reachable: coolMin - deadband > heatMin).
        const cool = clampMatterTemperature(toMatterTemperatureCelsius(targetC), COOL_MIN_CENTI, COOL_MAX_CENTI);
        const heat = clampMatterTemperature(
            Math.min(Math.round(DEFAULT_HEATING_SETPOINT_C * 100), cool - DEADBAND_CENTI), HEAT_MIN_CENTI, HEAT_MAX_CENTI,
        );
        return { heat, cool };
    }
    const heating = clampMatterTemperature(toMatterTemperatureCelsius(targetC), HEAT_MIN_CENTI, HEAT_MAX_CENTI);
    // If the natural cooling default would violate the deadband, push it up to heating + deadband.
    const cool = clampMatterTemperature(
        Math.max(Math.round(DEFAULT_COOLING_SETPOINT_C * 100), heating + DEADBAND_CENTI), COOL_MIN_CENTI, COOL_MAX_CENTI,
    );
    // Only possible at the very top of the cooling range: drag heating down instead.
    const heat = cool - heating < DEADBAND_CENTI ? Math.max(HEAT_MIN_CENTI, cool - DEADBAND_CENTI) : heating;
    return { heat, cool };
}

/**
 * Build the Thermostat cluster state for a Lares4 thermostat.
 *
 * Homebridge 2.5 derives the cluster features from the attributes declared at
 * registration (`homebridge/dist/matter/serverHelpers.js:370-390`), so the
 * conformant shape declares exactly what the output does: heating attributes
 * for a heating output, cooling attributes for a cooling output, both plus the
 * deadband (Heating + Cooling + AutoMode) for one that does both. No
 * unoccupied setpoint (Occupancy is not something the panel has, TH-09) and no
 * preset attribute (TH-01). The `legacy` shape is the 2.2.0 payload; see
 * `matter-thermostat-shape.ts`.
 */
export function buildThermostatMatterState(device: KseniaThermostat): ThermostatMatterState {
    const role = thermostatRole(device);
    const legacy = thermostatShapeOf(device.id) === 'legacy';
    const coolActive = isCoolingSetpointActiveForRole(role, modeOf(device));
    const localTempC = coerceToFiniteNumber(device.status?.currentTemperature ?? device.currentTemperature)
        ?? DEFAULT_LOCAL_TEMPERATURE_C;
    const targetC = coerceToFiniteNumber(device.status?.targetTemperature ?? device.targetTemperature)
        ?? (coolActive ? DEFAULT_COOLING_SETPOINT_C : DEFAULT_HEATING_SETPOINT_C);
    const heats = legacy || role !== 'cooling';
    const cools = legacy || role !== 'heating';

    const base: Record<string, unknown> = {
        localTemperature: clampMatterTemperature(toMatterTemperatureCelsius(localTempC), TEMP_ABS_MIN_CENTI, TEMP_ABS_MAX_CENTI),
    };
    const schemaInvariants: Record<string, unknown> = {};
    if (heats && cools) {
        const { heat, cool } = pairedSetpoints(coolActive, targetC);
        base.occupiedHeatingSetpoint = heat;
        base.occupiedCoolingSetpoint = cool;
        schemaInvariants.minSetpointDeadBand = Math.round(DEFAULT_DEADBAND_C * 10); // int8s in tenths of °C
    } else if (heats) {
        base.occupiedHeatingSetpoint = clampMatterTemperature(toMatterTemperatureCelsius(targetC), HEAT_MIN_CENTI, HEAT_MAX_CENTI);
    } else {
        base.occupiedCoolingSetpoint = clampMatterTemperature(toMatterTemperatureCelsius(targetC), COOL_MIN_CENTI, COOL_MAX_CENTI);
    }
    base.systemMode = thermostatSystemModeFor(role, device);

    if (heats) {
        Object.assign(schemaInvariants, {
            absMinHeatSetpointLimit: HEAT_MIN_CENTI, absMaxHeatSetpointLimit: HEAT_MAX_CENTI,
            minHeatSetpointLimit: HEAT_MIN_CENTI, maxHeatSetpointLimit: HEAT_MAX_CENTI,
        });
    }
    if (cools) {
        Object.assign(schemaInvariants, {
            absMinCoolSetpointLimit: COOL_MIN_CENTI, absMaxCoolSetpointLimit: COOL_MAX_CENTI,
            minCoolSetpointLimit: COOL_MIN_CENTI, maxCoolSetpointLimit: COOL_MAX_CENTI,
        });
    }
    // HeatingOnly forbids Cool, CoolingOnly forbids Heat
    // (`@matter/node/dist/esm/behaviors/thermostat/ThermostatServer.js:496-513`).
    schemaInvariants.controlSequenceOfOperation = role === 'heating'
        ? CONTROL_SEQ_HEATING_ONLY
        : (role === 'cooling' && !legacy ? CONTROL_SEQ_COOLING_ONLY : CONTROL_SEQ_COOLING_AND_HEATING);

    if (legacy) {
        base.unoccupiedHeatingSetpoint = base.occupiedHeatingSetpoint;
        base.unoccupiedCoolingSetpoint = base.occupiedCoolingSetpoint;
        Object.assign(schemaInvariants, getThermostatPresetWorkaroundAttributes());
        return { base, schemaInvariants };
    }
    // Declared at registration even when unknown, so later updates have an attribute to land on.
    const running = thermostatRunningState(role, device);
    if (running) base.thermostatRunningState = running;
    else schemaInvariants.thermostatRunningState = { heat: false, cool: false };
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
