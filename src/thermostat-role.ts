/**
 * Which half of a Ksenia thermostat program an output is: the program's
 * `HEATING_OUT`, its `COOLING_OUT`, or both. Domain data, shared by the
 * WebSocket client (which holds the programs and fills `status.outputRole`)
 * and the Matter mapping. The role comes from the program data; the panel's
 * own output name (never a custom or Matter name, invariant 3) is only the
 * fallback when no program names the output.
 */

import type { ThermostatOutputRole } from './types';

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
 * the panel's own name (`sourceName`) decides between heating-cooling and
 * heating; `undefined` when neither is given.
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
