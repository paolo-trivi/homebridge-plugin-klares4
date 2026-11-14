/**
 * Which half of a Ksenia thermostat program a Matter endpoint stands for.
 *
 * A program drives a heating output (`HEATING_OUT`) and a cooling output
 * (`COOLING_OUT`); the plugin exposes each output as a thermostat and both
 * receive the program's state. The role decides what the endpoint declares,
 * what it shows and which commands it forwards, so it comes from the program
 * data and never from a display name (invariant 3). The name is only the
 * fallback while no program data is available, and then it must be the
 * panel's own name, not a Matter or custom name.
 *
 * Pure functions only.
 */

import type { KseniaThermostat, ThermostatOutputRole } from '../types';

export type ThermostatSeason = 'winter' | 'summer';

/** The two output IDs of a program, as `PRG_THERMOSTATS` and the `.ksa` cache carry them. */
export interface ThermostatProgramOutputs {
    HEATING_OUT?: string;
    COOLING_OUT?: string;
}

const COOLING_NAME_HINTS = ['raffrescamento', 'raffreddamento', 'climatizzazione', 'cooling', 'cool'];

/** Legacy name heuristic, kept only as the fallback when the program data is missing. */
export function nameSuggestsCooling(name: string | undefined): boolean {
    const lower = name?.toLowerCase() ?? '';
    return COOLING_NAME_HINTS.some((hint) => lower.includes(hint));
}

function sameOutput(programOutput: string | undefined, outputId: string): boolean {
    if (typeof programOutput !== 'string') return false;
    const id = programOutput.trim();
    return id !== '' && id !== 'NU' && id === outputId.trim();
}

/**
 * Role of `outputId` in its program. Without a program that names the output,
 * the panel's own name (`sourceName`, before any custom or Matter name) decides
 * between heating-cooling and heating; `undefined` when neither is given.
 * Meant for the layer that holds the program data (WebSocket client / discovery).
 */
export function deriveThermostatOutputRole(
    outputId: string,
    program: ThermostatProgramOutputs | undefined,
    sourceName?: string,
): ThermostatOutputRole | undefined {
    const heating = sameOutput(program?.HEATING_OUT, outputId);
    const cooling = sameOutput(program?.COOLING_OUT, outputId);
    if (heating && cooling) return 'heating-cooling';
    if (heating) return 'heating';
    if (cooling) return 'cooling';
    if (sourceName === undefined) return undefined;
    return nameSuggestsCooling(sourceName) ? 'heating-cooling' : 'heating';
}

/**
 * The role the Matter endpoint uses. `status.outputRole` is authoritative; without it
 * the 2.2.0 name heuristic applies (on the name the mapper receives) until the
 * discovery layer fills the field in.
 */
export function thermostatRole(device: KseniaThermostat): ThermostatOutputRole {
    return device.status?.outputRole ?? (nameSuggestsCooling(device.name) ? 'heating-cooling' : 'heating');
}

const modeOf = (d: KseniaThermostat): KseniaThermostat['mode'] | undefined => d.status?.mode ?? d.mode;

/** Active season of the program: the realtime season, else what MAN implies (heat = winter, cool = summer). */
export function activeSeason(device: KseniaThermostat): ThermostatSeason | undefined {
    const season = device.status?.season;
    if (season === 'WIN') return 'winter';
    if (season === 'SUM') return 'summer';
    const mode = modeOf(device);
    if (mode === 'heat') return 'winter';
    if (mode === 'cool') return 'summer';
    return undefined;
}

const ROLE_SEASON: Record<'heating' | 'cooling', ThermostatSeason> = { heating: 'winter', cooling: 'summer' };

/**
 * False when the program runs in the other half of the year: a heating output
 * in summer, a cooling output in winter. Its setpoint is then not the one the
 * panel uses, and turning it on would switch the season of the whole program.
 * An unknown season does not count as out of season.
 */
export function isRoleInSeason(role: ThermostatOutputRole, device: KseniaThermostat): boolean {
    if (role === 'heating-cooling') return true;
    const season = activeSeason(device);
    return season === undefined || season === ROLE_SEASON[role];
}

/**
 * `thermostatRunningState` (RelayStateBitmap) from the state of this output:
 * the relay is the truth, the season only says which way an output that does
 * both is working. `undefined` when it cannot be known.
 */
export function thermostatRunningState(
    role: ThermostatOutputRole,
    device: KseniaThermostat,
): { heat: boolean; cool: boolean } | undefined {
    const active = device.status?.hvacOutputActive;
    if (typeof active !== 'boolean') return undefined;
    if (!active) return { heat: false, cool: false };
    if (role === 'heating') return { heat: true, cool: false };
    if (role === 'cooling') return { heat: false, cool: true };
    const season = activeSeason(device);
    if (season === undefined) return undefined;
    return season === 'winter' ? { heat: true, cool: false } : { heat: false, cool: true };
}
