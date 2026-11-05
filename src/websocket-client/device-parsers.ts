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

/**
 * Scenarios that arm or disarm the alarm run with the stored user PIN, so they
 * are never exposed. PARTIAL (partial arming) is hidden too unless the user
 * explicitly opts in with `exposePartialArmScenarios`.
 */
export function isIgnoredScenarioCategory(category?: string, exposePartialArm = false): boolean {
    const normalized = normalizeScenarioCategory(category);
    if (normalized === 'ARM' || normalized === 'DISARM') return true;
    return normalized === 'PARTIAL' && !exposePartialArm;
}

export function normalizeScenarioCategory(category?: string): string {
    return typeof category === 'string' ? category.trim().toUpperCase() : '';
}

export type ParsedOutputDevice = ReturnType<typeof parseOutputData> | KseniaGate;
