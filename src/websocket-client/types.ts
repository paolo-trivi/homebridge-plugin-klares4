import type {
    DomusThermostatConfig,
    KseniaBusHaData,
    KseniaDevice,
    KseniaOutputData,
    KseniaOutputStatusRaw,
    KseniaProgramThermostatRaw,
    KseniaSensorStatusRaw,
    KseniaTemperatureStatusRaw,
    KseniaZoneStatusRaw,
    KseniaMessage,
} from '../types';

export interface WebSocketConnectionOptions {
    rejectUnauthorized: boolean;
    agent?: import('https').Agent;
}

export interface PendingLoginRequest {
    /** ID of the LOGIN sent for this attempt; only its LOGIN_RES may settle it. */
    messageId?: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

export interface RealtimeStatusData {
    STATUS_OUTPUTS?: KseniaOutputStatusRaw[];
    STATUS_BUS_HA_SENSORS?: KseniaSensorStatusRaw[];
    STATUS_TEMPERATURES?: KseniaTemperatureStatusRaw[];
    STATUS_ZONES?: KseniaZoneStatusRaw[];
    STATUS_SYSTEM?: SystemTemperatureData[];
}

export interface SystemTemperatureData {
    ID: string;
    TEMP?: {
        IN?: string;
        OUT?: string;
    };
    [key: string]: unknown;
}

export interface KseniaCommandPayload {
    ID_LOGIN?: string;
    PIN?: string;
    ID_ITEMS_RANGE?: string[];
    TYPES?: string[];
    OUTPUT?: {
        ID: string;
        STA: string;
    };
    ID_THERMOSTAT?: string;
    MODE?: string;
    TARGET_TEMP?: string;
    CFG_THERMOSTATS?: Array<Record<string, unknown>>;
    SCENARIO?: {
        ID: string;
    };
    [key: string]: unknown;
}

export interface SendCommandOptions {
    awaitResponse?: boolean;
    timeoutMs?: number;
    responseCmds?: string[];
    requirePositiveResult?: boolean;
    allowGenericErrorFallback?: boolean;
    /** Response PAYLOAD_TYPEs accepted when the response ID does not match exactly. */
    responsePayloadTypes?: string[];
    stateConfirmation?: {
        outputId: string;
        matches: (status: KseniaOutputStatusRaw) => boolean;
    };
}

export type RawMessageDirection = 'in' | 'out';
export type RawMessageListener = (direction: RawMessageDirection, rawMessage: string) => void;

export interface CallbackRegistry {
    onDeviceDiscovered?: (device: KseniaDevice) => void;
    onDeviceStatusUpdate?: (device: KseniaDevice) => void;
    onConnected?: () => void;
    onDisconnected?: () => void;
    onInitialSyncComplete?: () => void;
}

export interface WebSocketClientState {
    ws?: import('ws');
    isConnected: boolean;
    idLogin?: string;
    heartbeatTimer?: ReturnType<typeof setInterval>;
    reconnectTimer?: ReturnType<typeof setTimeout>;
    heartbeatPending: boolean;
    lastPongReceived: number;
    reconnectAttempts: number;
    /** Explicit LOGIN_RES rejections since the last successful login. */
    loginRejections: number;
    /** Set after too many rejected logins: no automatic reconnection until restart. */
    reconnectSuspended: boolean;
    isManualClose: boolean;
    pendingLogin?: PendingLoginRequest;
    hasCompletedInitialSync: boolean;
    pendingOutputStatuses: Map<string, KseniaOutputStatusRaw>;
    pendingSensorStatuses: Map<string, KseniaSensorStatusRaw>;
    pendingTemperatureStatuses: Map<string, KseniaTemperatureStatusRaw>;
    pendingZoneStatuses: Map<string, KseniaZoneStatusRaw>;
    devices: Map<string, KseniaDevice>;
    domusThermostatConfig: Required<DomusThermostatConfig>;
    thermostatOutputs: Map<string, KseniaOutputData>;
    thermostatProgramById: Map<string, KseniaProgramThermostatRaw>;
    thermostatProgramIdByOutputId: Map<string, string>;
    domusSensorIdByThermostatProgramId: Map<string, string>;
    thermostatCommandIdByOutputId: Map<string, string>;
    thermostatCfgById: Map<string, Record<string, unknown>>;
    domusSensors: Map<string, KseniaBusHaData>;
    thermostatToDomus: Map<string, string>;
    thermostatMappingSource: Map<string, 'manual' | 'auto' | 'fallback' | 'program'>;
    domusLatest: Map<string, { temp?: number; hum?: number; ts: number }>;
    thermostatRealtimeByOutputId: Map<string, number>;
    thermostatRealtimeSnapshotById: Map<string, {
        mode?: string;
        season?: 'WIN' | 'SUM';
        targetTemperature?: number;
        hvacOutputActive?: boolean;
        updatedAt: number;
    }>;
    /**
     * Realtime ACT_SEA per OUTPUT thermostat id, stamped when the season last
     * changed. STATUS_TEMPERATURES is keyed by DOMUS sensor id, which can equal
     * another thermostat's cfg id, so the season is only looked up by output.
     */
    thermostatRealtimeSeasonByOutputId: Map<string, { season: 'WIN' | 'SUM'; updatedAt: number }>;
    missingThermostatProgramWarningOutputIds: Set<string>;
    /** Normalized CAT of every scenario listed by MULTI_TYPES, exposed or not. */
    scenarioCategoryById: Map<string, string>;
}

export interface MessagePipeline {
    routeMessage: (message: KseniaMessage) => void;
    resolvePending: (message: KseniaMessage) => void;
}
