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
    /**
     * Per-scenario PIN flag the panel reports (`N`, `P`, `PR` seen). Its exact
     * meaning is not established; it is recorded and reported, never used to
     * decide exposure.
     */
    PIN?: string;
}

export interface KseniaBusHaData {
    ID: string;
    DES: string;
    TYPE?: string;
    TYP?: string;
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

export interface KseniaTemperatureStatusRaw {
    ID: string;
    TEMP?: string;
    THERM?: {
        ACT_MODEL?: string;
        ACT_SEA?: string;
        ACT_TOF?: string;
        OUT_STATUS?: string;
        TEMP_THR?: {
            T?: string;
            VAL?: string;
        };
    };
}

export interface KseniaProgramThermostatRaw {
    ID: string;
    DES?: string;
    PERIPH?: {
        TYP?: string;
        PID?: string;
    };
    HEATING_OUT?: string;
    COOLING_OUT?: string;
    [key: string]: unknown;
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

export interface DomusThermostatManualCommandPair {
    thermostatOutputId: string;
    commandThermostatId: string;
}

export interface DomusThermostatConfig {
    enabled?: boolean;
    manualPairs?: DomusThermostatManualPair[];
    manualCommandPairs?: DomusThermostatManualCommandPair[];
    sensorFreshnessMs?: number;
}

export interface KsaImportConfig {
    enabled?: boolean;
    filePath?: string;
    applyAtStartup?: boolean;
    applyDomusMappings?: boolean;
    applyRoomMapping?: boolean;
    applyCustomNames?: boolean;
    applyExclusionSuggestions?: boolean;
}

export interface KsaSanitizedThermostatProgram {
    id: string;
    description?: string;
    heatingOutputId?: string;
    coolingOutputId?: string;
    domusSensorId?: string;
}

export interface KsaSanitizedCache {
    sourceFilePath?: string;
    sourceFileHash: string;
    parsedAt: string;
    thermostatPrograms: KsaSanitizedThermostatProgram[];
    thermostatProgramIdByOutputId: Record<string, string>;
    domusSensorIdByThermostatProgramId: Record<string, string>;
    outputNamesById: Record<string, string>;
    zoneNamesById: Record<string, string>;
    scenarioNamesById: Record<string, string>;
    domusSensorNamesById: Record<string, string>;
    roomNameById: Record<string, string>;
    roomDeviceRefs: Array<{
        roomId: string;
        objectType: string;
        objectId: string;
    }>;
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
    STATUS_TEMPERATURES?: KseniaTemperatureStatusRaw[];
    PRG_THERMOSTATS?: KseniaProgramThermostatRaw[];
    STATUS_ZONES?: KseniaZoneStatusRaw[];
    STATUS_SYSTEM?: KseniaSystemStatus[];
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

/**
 * Accessory types an output of an unrecognized category can be exposed as.
 * `light` keeps the device ID (`light_<id>`) such an output had in 2.2.0.
 */
export type OutputOptInType = 'light';

/** One `exposeOutputs` row: a panel output ID and the accessory type to expose it as. */
export interface OutputOptIn {
    outputId: string;
    exposeAs: OutputOptInType;
}

/** One `exposeScenarios` row: a panel scenario ID. */
export interface ScenarioOptIn {
    scenarioId: string;
}

export interface KseniaWebSocketOptions {
    debug?: boolean;
    logLevel?: number;
    reconnectInterval?: number;
    heartbeatInterval?: number;
    commandTimeoutMs?: number;
    allowInsecureTls?: boolean;
    loginTimeoutMs?: number;
    /** TCP connect + TLS + WebSocket upgrade budget in ms (internal, default 10000). */
    connectTimeoutMs?: number;
    /** Expose PARTIAL (partial-arm) scenarios; ARM/DISARM are never exposed. Default false. */
    exposePartialArmScenarios?: boolean;
    /** Outputs of an unrecognized category (GEN, IRR, none) to expose anyway, one by one. Default none. */
    exposeOutputs?: readonly OutputOptIn[];
    /** Scenarios of a category other than GEN (not ARM/DISARM/PARTIAL) to expose anyway, one by one. Default none. */
    exposeScenarios?: readonly ScenarioOptIn[];
    domusThermostat?: DomusThermostatConfig;
    ksaCache?: KsaSanitizedCache;
}
