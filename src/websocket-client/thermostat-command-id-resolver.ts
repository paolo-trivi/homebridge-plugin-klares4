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

interface ResolveThermostatCommandIdInput {
    outputThermostatId: string;
    hasProgramMapping: boolean;
    cachedCommandId?: string;
    manualCommandId?: string;
    programCommandId?: string;
    mappedDomusSensorId?: string;
    primeConfig: (candidateId: string) => Promise<boolean>;
    rememberCommandId: (resolvedCommandId: string) => void;
    onResolvedAlias?: (resolvedCommandId: string) => void;
}

export async function resolveThermostatCommandId({
    outputThermostatId,
    hasProgramMapping,
    cachedCommandId,
    manualCommandId,
    programCommandId,
    mappedDomusSensorId,
    primeConfig,
    rememberCommandId,
    onResolvedAlias,
}: ResolveThermostatCommandIdInput): Promise<string> {
    if (manualCommandId && await primeConfig(manualCommandId)) {
        rememberCommandId(manualCommandId);
        if (manualCommandId !== outputThermostatId) onResolvedAlias?.(manualCommandId);
        return manualCommandId;
    }

    if (programCommandId && await primeConfig(programCommandId)) {
        rememberCommandId(programCommandId);
        if (programCommandId !== outputThermostatId) onResolvedAlias?.(programCommandId);
        return programCommandId;
    }

    if (cachedCommandId) {
        return cachedCommandId;
    }

    if (hasProgramMapping) {
        return outputThermostatId;
    }

    const candidates = [mappedDomusSensorId, outputThermostatId].filter(
        (id, index, arr): id is string => Boolean(id) && arr.indexOf(id) === index,
    );
    for (const candidateId of candidates) {
        if (!await primeConfig(candidateId)) {
            continue;
        }
        rememberCommandId(candidateId);
        if (candidateId !== outputThermostatId) {
            onResolvedAlias?.(candidateId);
        }
        return candidateId;
    }
    return outputThermostatId;
}
