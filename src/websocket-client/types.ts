import type {
    DomusThermostatConfig,
    KseniaBusHaData,
    KseniaDevice,
    KseniaOutputData,
    KseniaOutputStatusRaw,
    KseniaSensorStatusRaw,
    KseniaZoneStatusRaw,
    KseniaMessage,
} from '../types';

export interface WebSocketConnectionOptions {
    rejectUnauthorized: boolean;
    agent?: import('https').Agent;
}

export interface PendingLoginRequest {
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

export interface RealtimeStatusData {
    STATUS_OUTPUTS?: KseniaOutputStatusRaw[];
    STATUS_BUS_HA_SENSORS?: KseniaSensorStatusRaw[];
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
    isManualClose: boolean;
    pendingLogin?: PendingLoginRequest;
    hasCompletedInitialSync: boolean;
    pendingOutputStatuses: Map<string, KseniaOutputStatusRaw>;
    pendingSensorStatuses: Map<string, KseniaSensorStatusRaw>;
    pendingZoneStatuses: Map<string, KseniaZoneStatusRaw>;
    devices: Map<string, KseniaDevice>;
    domusThermostatConfig: Required<DomusThermostatConfig>;
    thermostatOutputs: Map<string, KseniaOutputData>;
    domusSensors: Map<string, KseniaBusHaData>;
    thermostatToDomus: Map<string, string>;
    thermostatMappingSource: Map<string, 'manual' | 'auto' | 'fallback'>;
    domusLatest: Map<string, { temp?: number; hum?: number; ts: number }>;
}

export interface MessagePipeline {
    routeMessage: (message: KseniaMessage) => void;
    resolvePending: (message: KseniaMessage) => void;
}
