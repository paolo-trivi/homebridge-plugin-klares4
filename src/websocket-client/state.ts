import type { DomusThermostatConfig } from '../types';
import type { WebSocketClientState } from './types';

export function createInitialWebSocketClientState(
    domusThermostatConfig?: DomusThermostatConfig,
): WebSocketClientState {
    const resolvedDomusConfig: Required<DomusThermostatConfig> = {
        enabled: domusThermostatConfig?.enabled ?? true,
        manualPairs: domusThermostatConfig?.manualPairs ?? [],
        manualCommandPairs: domusThermostatConfig?.manualCommandPairs ?? [],
        sensorFreshnessMs: domusThermostatConfig?.sensorFreshnessMs ?? 300000,
    };

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
        thermostatProgramById: new Map(),
        thermostatProgramIdByOutputId: new Map(),
        domusSensorIdByThermostatProgramId: new Map(),
        thermostatCommandIdByOutputId: new Map(),
        thermostatCfgById: new Map(),
        domusSensors: new Map(),
        thermostatToDomus: new Map(),
        thermostatMappingSource: new Map(),
        domusLatest: new Map(),
        thermostatRealtimeByOutputId: new Map(),
        missingThermostatProgramWarningOutputIds: new Set(),
    };
}
