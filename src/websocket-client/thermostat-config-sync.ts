import { stripDevicePrefix } from '../device-id';
import { updateThermostatStatus } from '../thermostat-state';
import type { KseniaDevice, KseniaThermostat } from '../types';
import type { ThermostatMode } from '../thermostat-mode';
import { parseFloatInRange } from '../websocket/device-state-projector';
import type { WebSocketClientState } from './types';

interface ApplyThermostatConfigSnapshotInput {
    state: WebSocketClientState;
    emitDeviceStatusUpdate: (device: KseniaDevice) => void;
}

export function applyThermostatConfigSnapshot({
    state,
    emitDeviceStatusUpdate,
}: ApplyThermostatConfigSnapshotInput): void {
    for (const device of state.devices.values()) {
        if (device.type !== 'thermostat') {
            continue;
        }
        const outputThermostatId = stripDevicePrefix(device.id);
        const configThermostatId = resolveThermostatConfigId(state, outputThermostatId);
        if (!configThermostatId) {
            continue;
        }
        const cfg = state.thermostatCfgById.get(configThermostatId);
        if (!cfg) {
            continue;
        }

        const patch = buildThermostatPatchFromConfig(cfg);
        if (Object.keys(patch).length === 0) {
            continue;
        }

        const changed = updateThermostatStatus(device as KseniaThermostat, patch);
        state.thermostatCommandIdByOutputId.set(outputThermostatId, configThermostatId);
        if (changed) {
            emitDeviceStatusUpdate(device);
        }
    }
}

function resolveThermostatConfigId(
    state: WebSocketClientState,
    outputThermostatId: string,
): string | undefined {
    const manualPair = state.domusThermostatConfig.manualCommandPairs.find(
        (pair) => stripDevicePrefix(pair.thermostatOutputId) === outputThermostatId,
    );
    const manualId = manualPair ? stripDevicePrefix(manualPair.commandThermostatId) : undefined;
    const programId = state.thermostatProgramIdByOutputId.get(outputThermostatId);
    const cachedId = state.thermostatCommandIdByOutputId.get(outputThermostatId);
    const candidates = [manualId, programId, cachedId].filter(
        (candidate, index, items): candidate is string =>
            Boolean(candidate) && items.indexOf(candidate) === index,
    );
    const resolved = candidates.find((candidate) => state.thermostatCfgById.has(candidate));
    if (resolved) {
        return resolved;
    }

    if (state.thermostatProgramById.size > 0) {
        return undefined;
    }

    return state.thermostatCfgById.has(outputThermostatId) ? outputThermostatId : undefined;
}

function buildThermostatPatchFromConfig(cfg: Record<string, unknown>): Partial<{
    mode: ThermostatMode;
    targetTemperature: number;
}> {
    const patch: Partial<{ mode: ThermostatMode; targetTemperature: number }> = {};
    const mode = parseThermostatMode(cfg);
    if (mode !== undefined) {
        patch.mode = mode;
    }

    const targetTemperature = parseThermostatTarget(cfg, mode);
    if (targetTemperature !== undefined) {
        patch.targetTemperature = targetTemperature;
    }
    return patch;
}

function parseThermostatMode(cfg: Record<string, unknown>): ThermostatMode | undefined {
    const actMode = asUpperString(cfg.ACT_MODE);
    if (actMode === 'OFF') {
        return 'off';
    }
    if (actMode === 'AUTO') {
        return 'auto';
    }
    if (actMode === 'MAN') {
        return asUpperString(cfg.ACT_SEA) === 'SUM' ? 'cool' : 'heat';
    }
    return undefined;
}

function parseThermostatTarget(
    cfg: Record<string, unknown>,
    mode?: ThermostatMode,
): number | undefined {
    const season = pickSeason(cfg, mode);
    const seasonCfg = asObject(cfg[season]);
    const rawTm = asString(seasonCfg.TM) ?? asString(cfg.TM);
    return parseFloatInRange(rawTm, 5, 40);
}

function pickSeason(cfg: Record<string, unknown>, mode?: ThermostatMode): 'WIN' | 'SUM' {
    const explicitSeason = asUpperString(cfg.ACT_SEA);
    if (explicitSeason === 'WIN' || explicitSeason === 'SUM') {
        return explicitSeason;
    }
    return mode === 'cool' ? 'SUM' : 'WIN';
}

function asObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value.toString();
    }
    return undefined;
}

function asUpperString(value: unknown): string | undefined {
    const str = asString(value);
    return str ? str.toUpperCase() : undefined;
}
