import { stripDevicePrefix } from '../device-id';
import type { DomusThermostatManualPair } from '../types';

export type DomusMappingSource = 'manual' | 'auto' | 'fallback';

export interface BuildDomusMappingInput {
    thermostatOutputs: Map<string, { id: string; name: string }>;
    domusSensors: Map<string, { id: string; name: string }>;
    manualPairs: DomusThermostatManualPair[];
    scoreThreshold?: number;
}

export interface BuildDomusMappingResult {
    mapping: Map<string, string>;
    sources: Map<string, DomusMappingSource>;
    unmatched: string[];
}

const STOP_WORDS = new Set([
    'riscaldamento',
    'raffrescamento',
    'term',
    'termostato',
    'termo',
    'clima',
    'temp',
    'temperatura',
]);

function normalizeNumericId(id: string): string {
    const raw = String(id).trim();
    if (!/^[0-9]+$/.test(raw)) {
        return raw;
    }
    return String(Number.parseInt(raw, 10));
}

export function normalizeThermostatOutputId(id: string): string {
    return normalizeNumericId(stripDevicePrefix(String(id)).trim());
}

export function normalizeDomusSensorId(id: string): string {
    const raw = stripDevicePrefix(String(id)).trim();
    const parts = raw.split('_');
    const last = parts[parts.length - 1];
    return normalizeNumericId(/^[0-9]+$/.test(last) ? last : raw);
}

function normalizeName(value: string): string {
    return value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenizeName(value: string): string[] {
    return normalizeName(value)
        .split(' ')
        .map((token) => token.trim())
        .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function calculateTokenOverlapScore(left: string[], right: string[]): number {
    if (left.length === 0 || right.length === 0) {
        return 0;
    }

    const leftSet = new Set(left);
    const rightSet = new Set(right);
    let intersection = 0;
    for (const token of leftSet) {
        if (rightSet.has(token)) {
            intersection += 1;
        }
    }

    return intersection / Math.max(leftSet.size, rightSet.size);
}

export function buildDomusThermostatMapping(input: BuildDomusMappingInput): BuildDomusMappingResult {
    const threshold = input.scoreThreshold ?? 0.45;
    const mapping = new Map<string, string>();
    const sources = new Map<string, DomusMappingSource>();
    const thermostatEntries = [...input.thermostatOutputs.values()];
    const domusEntries = [...input.domusSensors.values()];

    // Manual mappings always win and are validated against discovered entities.
    for (const pair of input.manualPairs) {
        const thermostatId = normalizeThermostatOutputId(pair.thermostatOutputId);
        const domusId = normalizeDomusSensorId(pair.domusSensorId);
        if (!input.thermostatOutputs.has(thermostatId) || !input.domusSensors.has(domusId)) {
            continue;
        }
        mapping.set(thermostatId, domusId);
        sources.set(thermostatId, 'manual');
    }

    const takenByManual = new Set(mapping.values());
    const autoMatches = new Map<string, { sensorId: string; score: number }>();
    for (const thermostat of thermostatEntries) {
        const thermostatId = normalizeThermostatOutputId(thermostat.id);
        if (mapping.has(thermostatId)) {
            continue;
        }
        const match = bestSensorFor(thermostat.name, domusEntries);
        if (match && match.score >= threshold) {
            autoMatches.set(thermostatId, match);
        }
    }

    // A sensor is shared only on full name matches (heating and cooling output
    // of one room): a partial match ("Zona Notte" → "Zona Giorno") must not
    // route a thermostat to another room's sensor, and so to its cfg.
    const contenders = new Map<string, number>();
    for (const { sensorId } of autoMatches.values()) contenders.set(sensorId, (contenders.get(sensorId) ?? 0) + 1);
    for (const [thermostatId, { sensorId, score }] of autoMatches) {
        const shared = takenByManual.has(sensorId) || (contenders.get(sensorId) ?? 0) > 1;
        if (shared && score < 1) {
            continue;
        }
        mapping.set(thermostatId, sensorId);
        sources.set(thermostatId, 'auto');
    }

    const unmatched = thermostatEntries
        .map((entry) => normalizeThermostatOutputId(entry.id))
        .filter((id) => !mapping.has(id));

    for (const id of unmatched) {
        sources.set(id, 'fallback');
    }

    return {
        mapping,
        sources,
        unmatched,
    };
}

function bestSensorFor(
    thermostatName: string,
    domusEntries: Array<{ id: string; name: string }>,
): { sensorId: string; score: number } | undefined {
    const thermostatTokens = tokenizeName(thermostatName);
    let best: { sensorId: string; score: number } | undefined;
    let bestCount = 0;
    for (const sensor of domusEntries) {
        const score = calculateTokenOverlapScore(thermostatTokens, tokenizeName(sensor.name));
        if (!best || score > best.score) {
            best = { sensorId: sensor.id, score };
            bestCount = 1;
        } else if (score === best.score && score > 0) {
            bestCount += 1;
        }
    }
    return best && bestCount === 1 ? best : undefined;
}

export function normalizeDomusIdsForConfig(
    pairs: DomusThermostatManualPair[],
): DomusThermostatManualPair[] {
    return pairs.map((pair) => ({
        thermostatOutputId: normalizeThermostatOutputId(pair.thermostatOutputId),
        domusSensorId: normalizeDomusSensorId(pair.domusSensorId),
    }));
}
