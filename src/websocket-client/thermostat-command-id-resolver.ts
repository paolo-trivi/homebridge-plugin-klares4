interface ResolveThermostatCommandIdInput {
    outputThermostatId: string;
    cachedCommandId?: string;
    manualCommandId?: string;
    mappedDomusSensorId?: string;
    primeConfig: (candidateId: string) => Promise<boolean>;
    rememberCommandId: (resolvedCommandId: string) => void;
    onResolvedAlias?: (resolvedCommandId: string) => void;
}

export async function resolveThermostatCommandId({
    outputThermostatId,
    cachedCommandId,
    manualCommandId,
    mappedDomusSensorId,
    primeConfig,
    rememberCommandId,
    onResolvedAlias,
}: ResolveThermostatCommandIdInput): Promise<string> {
    if (cachedCommandId) {
        return cachedCommandId;
    }
    if (manualCommandId && await primeConfig(manualCommandId)) {
        rememberCommandId(manualCommandId);
        if (manualCommandId !== outputThermostatId) onResolvedAlias?.(manualCommandId);
        return manualCommandId;
    }
    const candidates = [outputThermostatId, mappedDomusSensorId].filter(
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
