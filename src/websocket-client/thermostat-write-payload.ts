import type { ThermostatMode } from '../thermostat-mode';

export function updateThermostatSeasonHint(
    seasonById: Map<string, 'WIN' | 'SUM'>,
    thermostatId: string,
    mode: ThermostatMode,
): void {
    if (mode === 'cool') {
        seasonById.set(thermostatId, 'SUM');
        return;
    }
    if (mode === 'heat') {
        seasonById.set(thermostatId, 'WIN');
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
    seasonById: Map<string, 'WIN' | 'SUM'>,
    thermostatId: string,
    temperature: number,
): Record<string, unknown> {
    const season = seasonById.get(thermostatId) ?? 'WIN';
    const tempValue = temperature.toFixed(1);
    if (season === 'SUM') {
        return {
            ACT_SEA: 'SUM',
            SUM: { TM: tempValue },
        };
    }
    return {
        ACT_SEA: 'WIN',
        WIN: { TM: tempValue },
    };
}
