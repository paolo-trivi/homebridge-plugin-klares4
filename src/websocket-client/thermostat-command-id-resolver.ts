import type { DegradedGuessVerdict } from './thermostat-degraded-guess';

export interface DegradedThermostatRoute {
    outputId: string;
    /** DOMUS sensor the thermostat measures, when known. */
    sensorId?: string;
}

/**
 * Without PRG_THERMOSTATS the cfg id is a guess: the DOMUS sensor id, else the
 * output id. The guess is ambiguous when it is also a candidate of another
 * thermostat that measures a different sensor, since that cfg may be the
 * other one's. Outputs sharing one sensor share one cfg and never conflict.
 * Returns the conflicting output id, if any.
 */
export function findDegradedCommandIdConflict(
    commandId: string,
    route: DegradedThermostatRoute,
    others: DegradedThermostatRoute[],
): string | undefined {
    for (const other of others) {
        if (other.outputId === route.outputId) continue;
        if (other.sensorId !== undefined && other.sensorId === route.sensorId) continue;
        if (other.sensorId === commandId || other.outputId === commandId) return other.outputId;
    }
    return undefined;
}

/** Where a cfg id came from: the user, the panel's programs, or a verified guess. */
export type ThermostatCommandIdSource = 'manual' | 'program' | 'degraded';

export interface ResolvedThermostatCommandId {
    id: string;
    source: ThermostatCommandIdSource;
}

interface ResolveThermostatCommandIdInput {
    outputThermostatId: string;
    hasProgramMapping: boolean;
    /** A guess verified earlier by a discriminating realtime match. */
    cachedCommandId?: string;
    manualCommandId?: string;
    programCommandId?: string;
    mappedDomusSensorId?: string;
    primeConfig: (candidateId: string) => Promise<boolean>;
    /** Whether a guessed cfg may be used (see judgeDegradedGuess), and remembered. */
    verifyGuess: (candidateId: string) => Promise<DegradedGuessVerdict>;
    rememberCommandId: (resolvedCommandId: string) => void;
    onResolvedAlias?: (resolvedCommandId: string) => void;
}

/** The thermostat's cfg id cannot be used: the write is refused, nothing is sent. */
export class ThermostatRoutingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ThermostatRoutingError';
    }
}

const manualPairHint = (outputId: string): string =>
    `set domusThermostat.manualCommandPairs, e.g. { "thermostatOutputId": "${outputId}", "commandThermostatId": "<cfg id>" }`;

/**
 * Fail-closed: a cfg id named by the user or by the panel's programs is the
 * only one tried for that thermostat; when it cannot be read the write is
 * refused instead of falling back to a guess, which may be another
 * thermostat's cfg. A guess (no programs, no pair) is used only if its cfg is
 * coherent with the realtime state of the thermostat.
 */
export async function resolveThermostatCommandId(
    input: ResolveThermostatCommandIdInput,
): Promise<ResolvedThermostatCommandId> {
    const { outputThermostatId: outputId, primeConfig } = input;
    const explicit: Array<[string | undefined, 'manual' | 'program', string]> = [
        [input.manualCommandId, 'manual', 'domusThermostat.manualCommandPairs'],
        [input.programCommandId, 'program', 'PRG_THERMOSTATS'],
    ];
    for (const [candidateId, source, origin] of explicit) {
        if (!candidateId) continue;
        if (!await primeConfig(candidateId)) {
            throw new ThermostatRoutingError(
                `thermostat_${outputId}: cfg id ${candidateId} (from ${origin}) could not be read from the panel; write refused`,
            );
        }
        return remember(input, candidateId, source);
    }

    if (input.hasProgramMapping) {
        throw new ThermostatRoutingError(
            `thermostat_${outputId} is not the heating or cooling output of any PRG_THERMOSTATS program; `
            + `write refused (${manualPairHint(outputId)})`,
        );
    }

    if (input.cachedCommandId) {
        if (await primeConfig(input.cachedCommandId)) return remember(input, input.cachedCommandId, 'degraded');
        throw new ThermostatRoutingError(
            `thermostat_${outputId}: cfg id ${input.cachedCommandId} could not be read from the panel; write refused`,
        );
    }

    const candidates = [input.mappedDomusSensorId, outputId].filter(
        (id, index, arr): id is string => Boolean(id) && arr.indexOf(id) === index,
    );
    for (const candidateId of candidates) {
        if (!await primeConfig(candidateId)) continue;
        const verdict = await input.verifyGuess(candidateId);
        if (!verdict.accepted) {
            throw new ThermostatRoutingError(
                `thermostat_${outputId}: without PRG_THERMOSTATS the cfg id is guessed (${candidateId}), and ${verdict.reason}; `
                + `write refused (${manualPairHint(outputId)})`,
            );
        }
        if (verdict.remember) return remember(input, candidateId, 'degraded');
        if (candidateId !== outputId) input.onResolvedAlias?.(candidateId);
        return { id: candidateId, source: 'degraded' };
    }
    throw new ThermostatRoutingError(
        `thermostat_${outputId}: no cfg could be read from the panel for this thermostat; write refused (${manualPairHint(outputId)})`,
    );
}

function remember(
    input: ResolveThermostatCommandIdInput,
    id: string,
    source: ThermostatCommandIdSource,
): ResolvedThermostatCommandId {
    input.rememberCommandId(id);
    if (id !== input.outputThermostatId) input.onResolvedAlias?.(id);
    return { id, source };
}
