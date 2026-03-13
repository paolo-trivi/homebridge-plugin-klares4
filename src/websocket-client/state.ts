import type { DomusThermostatConfig, KsaSanitizedCache } from '../types';
import type { WebSocketClientState } from './types';

export function createInitialWebSocketClientState(
    domusThermostatConfig?: DomusThermostatConfig,
    ksaCache?: KsaSanitizedCache,
): WebSocketClientState {
    const resolvedDomusConfig: Required<DomusThermostatConfig> = {
        enabled: domusThermostatConfig?.enabled ?? true,
        manualPairs: domusThermostatConfig?.manualPairs ?? [],
        manualCommandPairs: domusThermostatConfig?.manualCommandPairs ?? [],
        sensorFreshnessMs: domusThermostatConfig?.sensorFreshnessMs ?? 300000,
    };

    const thermostatProgramById = new Map<string, import('../types').KseniaProgramThermostatRaw>();
    const thermostatProgramIdByOutputId = new Map<string, string>();
    const domusSensorIdByThermostatProgramId = new Map<string, string>();

    if (ksaCache) {
        for (const program of ksaCache.thermostatPrograms) {
            thermostatProgramById.set(program.id, {
                ID: program.id,
                DES: program.description,
                PERIPH: program.domusSensorId ? { PID: program.domusSensorId } : undefined,
                HEATING_OUT: program.heatingOutputId,
                COOLING_OUT: program.coolingOutputId,
            });
        }
        for (const [outputId, thermostatProgramId] of Object.entries(ksaCache.thermostatProgramIdByOutputId)) {
            thermostatProgramIdByOutputId.set(outputId, thermostatProgramId);
        }
        for (const [thermostatProgramId, domusSensorId] of Object.entries(ksaCache.domusSensorIdByThermostatProgramId)) {
            domusSensorIdByThermostatProgramId.set(thermostatProgramId, domusSensorId);
        }
    }

    return {
        isConnected: false,
        heartbeatPending: false,
        lastPongReceived: 0,
        reconnectAttempts: 0,
        isManualClose: false,
        hasCompletedInitialSync: false,
        pendingOutputStatuses: new Map(),
        pendingSensorStatuses: new Map(),
        pendingTemperatureStatuses: new Map(),
        pendingZoneStatuses: new Map(),
        devices: new Map(),
        domusThermostatConfig: resolvedDomusConfig,
        thermostatOutputs: new Map(),
        thermostatProgramById,
        thermostatProgramIdByOutputId,
        domusSensorIdByThermostatProgramId,
        thermostatCommandIdByOutputId: new Map(),
        thermostatCfgById: new Map(),
        domusSensors: new Map(),
        thermostatToDomus: new Map(),
        thermostatMappingSource: new Map(),
        domusLatest: new Map(),
        thermostatRealtimeByOutputId: new Map(),
        thermostatRealtimeSnapshotById: new Map(),
        missingThermostatProgramWarningOutputIds: new Set(),
    };
}
