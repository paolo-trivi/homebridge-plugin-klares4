import type { ThermostatMode } from '../thermostat-mode';
import {
    buildThermostatModeCfgPayload,
    type ThermostatSeason,
} from './thermostat-write-payload';

/** What a batch of commands for one cfg asks for: the latest mode and setpoint. */
export interface ThermostatWriteIntent {
    mode?: ThermostatMode;
    temperature?: number;
}

interface BuildThermostatWriteInput {
    cfgId: string;
    intent: ThermostatWriteIntent;
    /** Season whose block receives the setpoint. */
    season: ThermostatSeason;
    /** The cfg as just read from the panel. Required for a setpoint. */
    cfg?: Record<string, unknown>;
    /** The season the panel is in now, when known: a mode already in it does not send ACT_SEA. */
    currentSeason?: ThermostatSeason;
}

/**
 * Partial WRITE_CFG entry, in the shapes the official Ksenia web app sends and
 * the panel acknowledges with WRITE_OK: a mode is `{ID, ACT_MODE}` (plus
 * `ACT_SEA` only to change season, a form never observed from the app), a setpoint is `{ID, <season>: block}` with
 * the season block exactly as just read and only `TM` changed. No other
 * top-level key is ever sent, so nothing changed on the keypad (mode, season,
 * the other season, MAN_HRS, TOF) can be written back. The whole block is sent
 * because a block with `TM` alone has never been observed: whether the panel
 * merges it or replaces the block (losing the schedule) is unknown.
 */
export function buildThermostatWritePayload({
    cfgId,
    intent,
    season,
    cfg,
    currentSeason,
}: BuildThermostatWriteInput): Record<string, unknown> {
    const payload: Record<string, unknown> = { ID: cfgId };
    if (intent.mode !== undefined) {
        const { ACT_SEA: modeSeason, ...modeKeys } = buildThermostatModeCfgPayload(intent.mode);
        Object.assign(payload, modeKeys);
        // The official app switches heating on with `{ID, ACT_MODE: "MAN"}` alone;
        // ACT_SEA only goes out when the mode needs the other season.
        if (modeSeason !== undefined && modeSeason !== currentSeason) payload.ACT_SEA = modeSeason;
    }
    if (intent.temperature !== undefined) {
        const block = cfg?.[season];
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
            throw new Error(`Thermostat cfg ${cfgId} read from the panel has no ${season} block: setpoint not written`);
        }
        payload[season] = {
            ...(JSON.parse(JSON.stringify(block)) as Record<string, unknown>),
            TM: intent.temperature.toFixed(1),
        };
    }
    return payload;
}

/** The cached cfg after the panel acknowledged `payload`: the keys sent replace the cached ones. */
export function applyAcknowledgedWrite(
    cached: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
    if (!cached) return undefined;
    return { ...cached, ...(JSON.parse(JSON.stringify(payload)) as Record<string, unknown>) };
}
