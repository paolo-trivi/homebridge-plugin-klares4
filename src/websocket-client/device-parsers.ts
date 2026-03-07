import type {
    KseniaGate,
    KseniaOutputData,
    KseniaScenario,
    KseniaScenarioData,
    KseniaZone,
    KseniaZoneData,
} from '../types';
import {
    determineOutputType as determineProjectedOutputType,
    parseOutputDevice,
} from '../websocket/device-state-projector';

export function parseZoneData(zoneData: KseniaZoneData): KseniaZone {
    return {
        id: `zone_${zoneData.ID}`,
        type: 'zone',
        name: zoneData.DES || `Zone ${zoneData.ID}`,
        description: zoneData.DES || '',
        status: {
            armed: zoneData.STATUS === '1',
            bypassed: false,
            fault: false,
            open: zoneData.STATUS === '2',
        },
    };
}

export function parseOutputData(outputData: KseniaOutputData) {
    return parseOutputDevice(outputData);
}

export function parseScenarioData(scenarioData: KseniaScenarioData): KseniaScenario | null {
    return {
        id: `scenario_${scenarioData.ID}`,
        type: 'scenario',
        name: scenarioData.DES || `Scenario ${scenarioData.ID}`,
        description: scenarioData.DES || '',
        status: {
            active: false,
        },
    };
}

export function determineOutputType(category: string, mode?: string): 'light' | 'cover' | 'gate' | 'thermostat' {
    return determineProjectedOutputType(category, mode);
}

export function isIgnoredScenarioCategory(category?: string): boolean {
    return category === 'ARM' || category === 'DISARM';
}

export type ParsedOutputDevice = ReturnType<typeof parseOutputData> | KseniaGate;
