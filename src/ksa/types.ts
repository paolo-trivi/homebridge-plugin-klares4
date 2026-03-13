import type { DomusThermostatManualCommandPair, DomusThermostatManualPair, KsaSanitizedCache, RoomMappingConfig } from '../types';

export interface KsaOutputRecord {
    ID: string;
    DES?: string;
    CAT?: string;
    MOD?: string;
}

export interface KsaZoneRecord {
    ID: string;
    DES?: string;
    CAT?: string;
}

export interface KsaScenarioRecord {
    ID: string;
    DES?: string;
    ACT?: string;
}

export interface KsaBusHasRecord {
    ID: string;
    DOMUS?: {
        DES?: string;
    };
}

export interface KsaThermostatRecord {
    ID: string;
    DES?: string;
    PERIPH?: {
        TYP?: string;
        PID?: string;
    };
    HEATING_OUT?: string;
    COOLING_OUT?: string;
}

export interface KsaRoomRecord {
    ID: string;
    DES?: string;
}

export interface KsaMapRecord {
    ROOM?: string;
    OT?: string;
    OID?: string;
}

export interface ParsedKsaProgram {
    outputs: KsaOutputRecord[];
    zones: KsaZoneRecord[];
    scenarios: KsaScenarioRecord[];
    busHas: KsaBusHasRecord[];
    thermostats: KsaThermostatRecord[];
    rooms: KsaRoomRecord[];
    maps: KsaMapRecord[];
}

export interface KsaDerivedConfig {
    domusThermostat: {
        manualPairs: DomusThermostatManualPair[];
        manualCommandPairs: DomusThermostatManualCommandPair[];
    };
    roomMapping: RoomMappingConfig;
    customNames: {
        outputs: Record<string, string>;
        zones: Record<string, string>;
        sensors: Record<string, string>;
        scenarios: Record<string, string>;
    };
    suggestedExclusions: {
        outputs: string[];
        zones: string[];
        sensors: string[];
        scenarios: string[];
    };
}

export interface KsaImportSummary {
    outputs: number;
    zones: number;
    scenarios: number;
    sensors: number;
    thermostats: number;
    rooms: number;
    maps: number;
}

export interface KsaImportResult {
    summary: KsaImportSummary;
    cache: KsaSanitizedCache;
    derivedConfig: KsaDerivedConfig;
}
