import type { ThermostatMode } from '../thermostat-mode';

export type ThermostatSeason = 'WIN' | 'SUM';

export function asSeason(value: unknown): ThermostatSeason | undefined {
    const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return upper === 'WIN' || upper === 'SUM' ? upper : undefined;
}

/** A season seen on the panel (realtime ACT_SEA, or the ACT_SEA of a cfg read) and when. */
export interface SeasonObservation {
    season?: ThermostatSeason;
    at: number;
}

/**
 * Which season a thermostat is really in, so a setpoint lands in the right
 * block. The freshest of the panel's observations (realtime, cfg read) and our
 * last acknowledged WRITE_CFG wins; on a tie the panel wins. An ACK is only a
 * claim until the panel shows it: an ACK older than the latest observation
 * never overrides it, however long ago that observation last changed.
 * A command is recorded only once the panel accepted it: a rejected "cool"
 * must not move later setpoints to summer.
 */
export class ThermostatSeasonTracker {
    private readonly acknowledged = new Map<string, { season: ThermostatSeason; at: number }>();

    public recordAcknowledged(cfgId: string, season: ThermostatSeason | undefined, at = Date.now()): void {
        if (season) this.acknowledged.set(cfgId, { season, at });
    }

    public resolve(cfgId: string, observations: Array<SeasonObservation | undefined>): ThermostatSeason {
        return this.resolveKnown(cfgId, observations) ?? 'WIN';
    }

    /** As resolve, without the WIN default: `undefined` when nothing was ever observed. */
    public resolveKnown(cfgId: string, observations: Array<SeasonObservation | undefined>): ThermostatSeason | undefined {
        let best: SeasonObservation | undefined;
        for (const observation of observations) {
            if (!observation?.season) continue;
            if (!best || observation.at >= best.at) best = observation;
        }
        const acked = this.acknowledged.get(cfgId);
        if (acked && (!best || acked.at > best.at)) return acked.season;
        return best?.season;
    }
}

/** Top-level keys of a mode write, as the official app sends them (`{ID, ACT_MODE}`). */
export function buildThermostatModeCfgPayload(mode: ThermostatMode): Record<string, string> {
    switch (mode) {
        case 'off':
            return { ACT_MODE: 'OFF' };
        case 'cool':
            return { ACT_MODE: 'MAN', ACT_SEA: 'SUM' };
        case 'heat':
            return { ACT_MODE: 'MAN', ACT_SEA: 'WIN' };
        case 'auto':
        default:
            return { ACT_MODE: 'AUTO' };
    }
}

/** The season a mode selects, if it selects one. */
export function seasonOfMode(mode: ThermostatMode | undefined): ThermostatSeason | undefined {
    return asSeason(mode ? buildThermostatModeCfgPayload(mode).ACT_SEA : undefined);
}
