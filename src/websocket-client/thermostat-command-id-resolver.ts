interface ResolveThermostatCommandIdInput {
    outputThermostatId: string;
    hasProgramMapping: boolean;
    cachedCommandId?: string;
    manualCommandId?: string;
    programCommandId?: string;
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

    const candidates = [outputThermostatId].filter(
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
