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
    normalizeDeviceName,
    parseOutputDevice,
} from '../websocket/device-state-projector';

export function parseZoneData(zoneData: KseniaZoneData): KseniaZone {
    const label = normalizeDeviceName(zoneData.DES);
    return {
        id: `zone_${zoneData.ID}`,
        type: 'zone',
        name: label || `Zone ${zoneData.ID}`,
        description: label,
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
    const label = normalizeDeviceName(scenarioData.DES);
    return {
        id: `scenario_${scenarioData.ID}`,
        type: 'scenario',
        name: label || `Scenario ${scenarioData.ID}`,
        description: label,
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
