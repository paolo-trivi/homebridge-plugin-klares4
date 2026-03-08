import type { Logger } from 'homebridge';
import { buildDomusThermostatMapping, normalizeDomusIdsForConfig } from './domus-thermostat-mapper';
import type { WebSocketClientState } from './types';

export function refreshDomusThermostatMapping(state: WebSocketClientState, log: Logger): void {
    const config = state.domusThermostatConfig;
    if (!config.enabled) {
        state.thermostatToDomus.clear();
        state.thermostatMappingSource.clear();
        return;
    }
    if (state.thermostatOutputs.size === 0 || state.domusSensors.size === 0) {
        return;
    }

    const thermostatOutputs = new Map<string, { id: string; name: string }>();
    for (const output of state.thermostatOutputs.values()) {
        thermostatOutputs.set(output.ID, {
            id: output.ID,
            name: output.DES || `Thermostat ${output.ID}`,
        });
    }

    const domusSensors = new Map<string, { id: string; name: string }>();
    for (const sensor of state.domusSensors.values()) {
        domusSensors.set(sensor.ID, {
            id: sensor.ID,
            name: sensor.DES || `Sensor ${sensor.ID}`,
        });
    }

    const result = buildDomusThermostatMapping({
        thermostatOutputs,
        domusSensors,
        manualPairs: normalizeDomusIdsForConfig(config.manualPairs),
    });
    state.thermostatToDomus = result.mapping;
    state.thermostatMappingSource = result.sources;

    log.info('DOMUS thermostat mapping initialized');
    for (const [thermostatId, sensorId] of result.mapping.entries()) {
        const source = result.sources.get(thermostatId) ?? 'fallback';
        log.info(`DOMUS mapping thermostat_${thermostatId} -> sensor_${sensorId} (${source})`);
    }
    for (const thermostatId of result.unmatched) {
        log.warn(
            `DOMUS mapping missing for thermostat_${thermostatId}, using STATUS_SYSTEM fallback`,
        );
    }
}
