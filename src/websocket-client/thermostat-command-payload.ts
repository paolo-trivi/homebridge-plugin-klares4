import type { ThermostatMode } from '../thermostat-mode';
import {
    buildThermostatModeCfgPayload,
    buildThermostatSetpointCfgPayload,
} from './thermostat-write-payload';

interface BuildSetpointPayloadInput {
    systemThermostatId: string;
    temperature: number;
    seasonById: Map<string, 'WIN' | 'SUM'>;
    existingCfg?: Record<string, unknown>;
}

export function buildThermostatModeCommandPayload(
    systemThermostatId: string,
    mode: ThermostatMode,
    existingCfg?: Record<string, unknown>,
): Record<string, unknown> {
    const commandPayload = buildThermostatModeCfgPayload(mode);
    if (!existingCfg) {
        return {
            ID: systemThermostatId,
            ...commandPayload,
        };
    }
    const merged = cloneThermostatCfg(existingCfg);
    merged.ID = systemThermostatId;
    for (const [key, value] of Object.entries(commandPayload)) {
        merged[key] = value;
    }
    return merged;
}

export function buildThermostatSetpointCommandPayload({
    systemThermostatId,
    temperature,
    seasonById,
    existingCfg,
}: BuildSetpointPayloadInput): Record<string, unknown> {
    const setpointPatch = buildThermostatSetpointCfgPayload(
        seasonById,
        systemThermostatId,
        temperature,
    );
    if (!existingCfg) {
        return {
            ID: systemThermostatId,
            ACT_MODE: 'MAN',
            ...setpointPatch,
        };
    }

    const merged = cloneThermostatCfg(existingCfg);
    merged.ID = systemThermostatId;
    merged.ACT_MODE = 'MAN';
    const activeSeason = String(
        seasonById.get(systemThermostatId)
        ?? merged.ACT_SEA
        ?? (setpointPatch.ACT_SEA as string | undefined)
        ?? 'WIN',
    ).toUpperCase() === 'SUM' ? 'SUM' : 'WIN';
    merged.ACT_SEA = activeSeason;
    const seasonPatch = toPlainObject(setpointPatch[activeSeason]);
    const seasonCfg = toPlainObject(merged[activeSeason]);
    merged[activeSeason] = {
        ...seasonCfg,
        ...seasonPatch,
    };
    return merged;
}

function cloneThermostatCfg(cfg: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
}

function toPlainObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value as Record<string, unknown>;
}
