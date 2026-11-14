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
}

/**
 * Partial WRITE_CFG entry, in the shapes the official Ksenia web app sends and
 * the panel acknowledges with WRITE_OK: a mode is `{ID, ACT_MODE}` (`ACT_SEA`
 * too when the mode picks a season), a setpoint is `{ID, <season>: block}` with
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
}: BuildThermostatWriteInput): Record<string, unknown> {
    const payload: Record<string, unknown> = { ID: cfgId };
    if (intent.mode !== undefined) {
        Object.assign(payload, buildThermostatModeCfgPayload(intent.mode));
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
