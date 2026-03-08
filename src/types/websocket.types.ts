export interface KseniaOutputData {
    ID: string;
    DES: string;
    TYPE: string;
    STATUS: string;
    POS?: string;
    ENABLED: string;
    CAT?: string;
    MOD?: string;
}

export interface KseniaZoneData {
    ID: string;
    DES: string;
    TYPE: string;
    STATUS: string;
    ENABLED: string;
}

export interface KseniaSensorData {
    ID: string;
    DES: string;
    TYPE: string;
    VALUE: string;
    UNIT?: string;
    ENABLED: string;
}

export interface KseniaScenarioData {
    ID: string;
    DES: string;
    CAT?: string;
    ENABLED?: string;
}

export interface KseniaBusHaData {
    ID: string;
    DES: string;
    TYPE?: string;
    ENABLED?: string;
}

export interface KseniaOutputStatusRaw {
    ID: string;
    STA: string;
    POS?: string;
    TPOS?: string;
    TEMP_CURRENT?: string;
    TEMP_TARGET?: string;
    MODE?: string;
}

export interface KseniaSensorStatusRaw {
    ID: string;
    DOMUS?: {
        TEM?: string;
        HUM?: string;
        LHT?: string;
    };
}

export interface KseniaZoneStatusRaw {
    ID: string;
    STA: string;
    BYP?: string;
    A?: string;
    FM?: string;
}

export interface KseniaSystemStatus {
    ID?: string;
    TEMP?: {
        IN?: string;
        OUT?: string;
    };
    [key: string]: unknown;
}

export interface KseniaOutputCommand {
    ID: string;
    STA: string;
}

export interface DomusThermostatManualPair {
    thermostatOutputId: string;
    domusSensorId: string;
}

export interface DomusThermostatConfig {
    enabled?: boolean;
    manualPairs?: DomusThermostatManualPair[];
    sensorFreshnessMs?: number;
}

export interface KseniaMessagePayload {
    PIN?: string;
    ID_LOGIN?: string;
    RESULT?: string;
    RESULT_DETAIL?: string;
    ZONES?: KseniaZoneData[];
    OUTPUTS?: KseniaOutputData[];
    SCENARIOS?: KseniaScenarioData[];
    BUS_HAS?: KseniaBusHaData[];
    STATUS_OUTPUTS?: KseniaOutputStatusRaw[];
    STATUS_BUS_HA_SENSORS?: KseniaSensorStatusRaw[];
    STATUS_ZONES?: KseniaZoneStatusRaw[];
    STATUS_SYSTEM?: KseniaSystemStatus;
    ID_ITEMS_RANGE?: string[];
    TYPES?: string[];
    OUTPUT?: KseniaOutputCommand;
    [key: string]: unknown;
}

export interface KseniaMessage {
    SENDER: string;
    RECEIVER: string;
    CMD: string;
    ID: string;
    PAYLOAD_TYPE: string;
    PAYLOAD: KseniaMessagePayload;
    TIMESTAMP: string;
    CRC_16: string;
}

export interface KseniaWebSocketOptions {
    debug?: boolean;
    logLevel?: number;
    reconnectInterval?: number;
    heartbeatInterval?: number;
    commandTimeoutMs?: number;
    allowInsecureTls?: boolean;
    loginTimeoutMs?: number;
    domusThermostat?: DomusThermostatConfig;
}
