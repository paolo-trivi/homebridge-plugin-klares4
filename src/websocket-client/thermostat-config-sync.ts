import { stripDevicePrefix } from '../device-id';
import { updateThermostatStatus } from '../thermostat-state';
import type { KseniaDevice, KseniaThermostat } from '../types';
import type { ThermostatMode } from '../thermostat-mode';
import { parseFloatInRange } from '../websocket/device-state-projector';
import type { WebSocketClientState } from './types';

interface ApplyThermostatConfigSnapshotInput {
    state: WebSocketClientState;
    emitDeviceStatusUpdate: (device: KseniaDevice) => void;
    /** Only these cfg ids (those a READ_RES just returned); all when omitted. */
    cfgIds?: ReadonlySet<string>;
}

/**
 * Fills the state of thermostats from the cfg read from the panel, only until
 * the panel reports them in realtime: STATUS_TEMPERATURES is the live state,
 * the cfg only what was configured. In AUTO the cfg's TM is the manual
 * setpoint, not the program's live target, so it is not shown.
 */
export function applyThermostatConfigSnapshot({
    state,
    emitDeviceStatusUpdate,
    cfgIds,
}: ApplyThermostatConfigSnapshotInput): void {
    for (const device of state.devices.values()) {
        if (device.type !== 'thermostat') {
            continue;
        }
        const outputThermostatId = stripDevicePrefix(device.id);
        if (state.thermostatRealtimeByOutputId.has(outputThermostatId)) {
            continue;
        }
        const configThermostatId = resolveThermostatConfigId(state, outputThermostatId);
        if (!configThermostatId || (cfgIds && !cfgIds.has(configThermostatId))) {
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

/**
 * Only ids that are not a guess: a manual pair, the program, or one the
 * command resolver already verified. Without them the thermostat waits for
 * its realtime state (a guessed cfg may be another thermostat's).
 */
function resolveThermostatConfigId(
    state: WebSocketClientState,
    outputThermostatId: string,
): string | undefined {
    const manualPair = state.domusThermostatConfig.manualCommandPairs.find(
        (pair) => stripDevicePrefix(pair.thermostatOutputId) === outputThermostatId,
    );
    if (manualPair) return stripDevicePrefix(manualPair.commandThermostatId);
    return state.thermostatProgramIdByOutputId.get(outputThermostatId)
        ?? state.thermostatCommandIdByOutputId.get(outputThermostatId);
}

/** Realtime view of a thermostat (thermostatRealtimeSnapshotById). */
export interface ThermostatRealtimeView {
    mode?: string;
    season?: 'WIN' | 'SUM';
    targetTemperature?: number;
}

/**
 * Whether a cfg describes what a thermostat reports in realtime: same mode and
 * season and, in manual, the same setpoint. Used to accept a guessed cfg id.
 * Two programs in the very same state cannot be told apart this way.
 */
export function isCfgCoherentWithRealtime(
    cfg: Record<string, unknown> | undefined,
    realtime: ThermostatRealtimeView | undefined,
): boolean {
    if (!cfg || !realtime || realtime.mode === undefined) return false;
    const mode = parseThermostatMode(cfg);
    if (mode === undefined || mode !== realtime.mode) return false;
    const season = asUpperString(cfg.ACT_SEA);
    if (realtime.season !== undefined && season !== undefined && season !== realtime.season) return false;
    if (mode !== 'heat' && mode !== 'cool') return true;
    const target = parseThermostatTarget(cfg, mode);
    return target !== undefined && realtime.targetTemperature !== undefined
        && Math.abs(target - realtime.targetTemperature) < 0.05;
}

function buildThermostatPatchFromConfig(cfg: Record<string, unknown>): Partial<{
    mode: ThermostatMode;
    targetTemperature: number;
    season: 'WIN' | 'SUM';
}> {
    const patch: Partial<{ mode: ThermostatMode; targetTemperature: number; season: 'WIN' | 'SUM' }> = {};
    const mode = parseThermostatMode(cfg);
    if (mode !== undefined) {
        patch.mode = mode;
    }

    const season = asUpperString(cfg.ACT_SEA);
    if (season === 'WIN' || season === 'SUM') {
        patch.season = season;
    }
    const targetTemperature = mode === 'auto' ? undefined : parseThermostatTarget(cfg, mode);
    if (targetTemperature !== undefined) {
        patch.targetTemperature = targetTemperature;
    }
    return patch;
}

export function parseThermostatMode(cfg: Record<string, unknown>): ThermostatMode | undefined {
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
