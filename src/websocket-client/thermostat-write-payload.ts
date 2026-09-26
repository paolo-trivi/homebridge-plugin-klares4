import type { ThermostatMode } from '../thermostat-mode';

export type ThermostatSeason = 'WIN' | 'SUM';

function asSeason(value: unknown): ThermostatSeason | undefined {
    const upper = typeof value === 'string' ? value.toUpperCase() : '';
    return upper === 'WIN' || upper === 'SUM' ? upper : undefined;
}

/**
 * Which season a thermostat is really in, so a setpoint lands in the right
 * block. The freshest of two observations wins: the season carried by our last
 * acknowledged WRITE_CFG, and the one the panel reports in realtime
 * (STATUS_TEMPERATURES.THERM.ACT_SEA). Without either, the cached cfg decides.
 * A command is recorded only once the panel accepted it: a rejected "cool"
 * must not move later setpoints to summer.
 */
export class ThermostatSeasonTracker {
    private readonly acknowledged = new Map<string, { season: ThermostatSeason; at: number }>();

    public recordAcknowledged(thermostatId: string, cfgEntry: Record<string, unknown>): void {
        const season = asSeason(cfgEntry.ACT_SEA);
        if (season) this.acknowledged.set(thermostatId, { season, at: Date.now() });
    }

    public resolve(
        thermostatId: string,
        realtime: { season?: ThermostatSeason; updatedAt: number } | undefined,
        cfg: Record<string, unknown> | undefined,
    ): ThermostatSeason {
        const acked = this.acknowledged.get(thermostatId);
        if (acked && realtime?.season) return realtime.updatedAt > acked.at ? realtime.season : acked.season;
        return acked?.season ?? realtime?.season ?? asSeason(cfg?.ACT_SEA) ?? 'WIN';
    }
}

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

export function buildThermostatSetpointCfgPayload(
    season: ThermostatSeason,
    temperature: number,
): Record<string, unknown> {
    return { ACT_SEA: season, [season]: { TM: temperature.toFixed(1) } };
}
