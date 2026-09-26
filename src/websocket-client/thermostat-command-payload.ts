import type { ThermostatMode } from '../thermostat-mode';
import {
    buildThermostatModeCfgPayload,
    buildThermostatSetpointCfgPayload,
    type ThermostatSeason,
} from './thermostat-write-payload';

interface BuildSetpointPayloadInput {
    systemThermostatId: string;
    temperature: number;
    /** Season the panel is in (see ThermostatSeasonTracker); defaults to the cfg's own. */
    season?: ThermostatSeason;
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
    season,
    existingCfg,
}: BuildSetpointPayloadInput): Record<string, unknown> {
    const cfgSeason = String(existingCfg?.ACT_SEA ?? '').toUpperCase() === 'SUM' ? 'SUM' : 'WIN';
    const activeSeason = season ?? cfgSeason;
    // The patch must target the season that is actually active: writing the
    // other season's block leaves the live setpoint unchanged while the panel
    // still acknowledges the write.
    const setpointPatch = buildThermostatSetpointCfgPayload(activeSeason, temperature);
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
    merged.ACT_SEA = activeSeason;
    merged[activeSeason] = {
        ...toPlainObject(merged[activeSeason]),
        ...toPlainObject(setpointPatch[activeSeason]),
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
