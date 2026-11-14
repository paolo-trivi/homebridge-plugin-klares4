import type {
    KseniaGate,
    KseniaOutputData,
    KseniaScenario,
    KseniaScenarioData,
    KseniaZone,
    KseniaZoneData,
    OutputOptIn,
    OutputOptInType,
    ScenarioOptIn,
} from '../types';
import { normalizeDeviceName, parseOutputDevice } from '../websocket/device-state-projector';
import {
    determineOutputType as determineProjectedOutputType,
    type ProjectedOutputType,
} from '../websocket/output-classifier';

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

export function parseScenarioData(scenarioData: KseniaScenarioData): KseniaScenario {
    const label = normalizeDeviceName(scenarioData.DES);
    return {
        id: `scenario_${scenarioData.ID}`,
        type: 'scenario',
        name: label || `Scenario ${scenarioData.ID}`,
        description: label,
        status: {
            active: false,
        },
        ...(typeof scenarioData.PIN === 'string' ? { pinFlag: scenarioData.PIN.trim().toUpperCase() } : {}),
    };
}

export function determineOutputType(category: string, mode?: string): ProjectedOutputType | undefined {
    return determineProjectedOutputType(category, mode);
}

/**
 * Scenario categories that are run without an opt-in: they cannot arm or
 * disarm the alarm. Anything else (absent, empty, not a string, unknown such
 * as `ARM_AWAY`) is hidden unless listed in `exposeScenarios`.
 */
const HARMLESS_SCENARIO_CATEGORIES: ReadonlySet<string> = new Set(['GEN']);

export type ScenarioExposure =
    | { exposed: true; source: 'category' | 'partial-arm-opt-in' | 'opt-in' }
    | { exposed: false; reason: 'arming' | 'partial-arm' | 'unknown-category' };

/**
 * The scenario policy (allowlist). ARM and DISARM run with the stored user
 * PIN, so they are never exposed, not even with an opt-in. PARTIAL (partial
 * arming) follows `exposePartialArmScenarios` only. GEN is exposed. Any other
 * category is exposed only when the scenario is listed in `exposeScenarios`
 * (`optedIn`).
 */
export function resolveScenarioExposure(
    category: unknown,
    exposePartialArm = false,
    optedIn = false,
): ScenarioExposure {
    const normalized = normalizeScenarioCategory(category);
    if (normalized === 'ARM' || normalized === 'DISARM') return { exposed: false, reason: 'arming' };
    if (normalized === 'PARTIAL') {
        return exposePartialArm ? { exposed: true, source: 'partial-arm-opt-in' } : { exposed: false, reason: 'partial-arm' };
    }
    if (HARMLESS_SCENARIO_CATEGORIES.has(normalized)) return { exposed: true, source: 'category' };
    return optedIn ? { exposed: true, source: 'opt-in' } : { exposed: false, reason: 'unknown-category' };
}

/**
 * True when the scenario must be neither exposed nor run: see
 * `resolveScenarioExposure`. `optedIn` is whether `exposeScenarios` lists it.
 */
export function isIgnoredScenarioCategory(category?: string, exposePartialArm = false, optedIn = false): boolean {
    return !resolveScenarioExposure(category, exposePartialArm, optedIn).exposed;
}

export function normalizeScenarioCategory(category?: unknown): string {
    return typeof category === 'string' ? category.trim().toUpperCase() : '';
}

/** Panel IDs listed in `exposeScenarios`, as a lookup set. */
export function scenarioOptInIds(optIns: readonly ScenarioOptIn[] | undefined): ReadonlySet<string> {
    return new Set((optIns ?? []).map((row) => String(row.scenarioId)));
}

/** Output panel ID → accessory type listed in `exposeOutputs`. */
export function outputOptInTypes(optIns: readonly OutputOptIn[] | undefined): ReadonlyMap<string, OutputOptInType> {
    return new Map((optIns ?? []).map((row) => [String(row.outputId), row.exposeAs]));
}

export type ParsedOutputDevice = ReturnType<typeof parseOutputData> | KseniaGate;
