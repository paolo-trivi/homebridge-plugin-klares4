import type { KseniaDevice, KseniaSensor } from '../types';
import type { Logger } from 'homebridge';
import { stripDevicePrefix } from '../device-id';
import { LogLevel } from '../log-levels';
import { updateThermostatStatus } from '../thermostat-state';
import { parseFloatInRange } from '../websocket/device-state-projector';
import { forEachIsolated } from '../isolation';
import type { SystemTemperatureData, WebSocketClientState } from './types';

interface SystemTemperatureUpdaterDeps {
    state: WebSocketClientState;
    log: Logger;
    logLevel: LogLevel;
    emitDeviceDiscovered: (device: KseniaDevice) => void;
    emitDeviceStatusUpdate: (device: KseniaDevice) => void;
}

export class SystemTemperatureUpdater {
    constructor(private readonly deps: SystemTemperatureUpdaterDeps) {}

    public updateSystemTemperatures(systemData: SystemTemperatureData[]): void {
        forEachIsolated(this.deps.log, 'STATUS_SYSTEM entry', systemData, (system: SystemTemperatureData): void => {
            if (this.deps.logLevel >= LogLevel.DEBUG) {
                this.deps.log.debug(`System data ${system.ID}: ${JSON.stringify(system)}`);
            }

            if (!system.TEMP) {
                return;
            }

            const internalTempStr = system.TEMP.IN;
            const externalTempStr = system.TEMP.OUT;

            const internalTemp =
                internalTempStr && internalTempStr !== 'NA'
                    ? parseFloatInRange(internalTempStr, -50, 100)
                    : undefined;
            const externalTemp =
                externalTempStr && externalTempStr !== 'NA'
                    ? parseFloatInRange(externalTempStr, -50, 100)
                    : undefined;

            if (internalTemp !== undefined && !isNaN(internalTemp)) {
                const sensorId = 'sensor_system_temp_in';
                let tempDevice = this.deps.state.devices.get(sensorId);

                if (!tempDevice) {
                    tempDevice = {
                        id: sensorId,
                        type: 'sensor',
                        name: 'Temperatura Interna',
                        description: 'Temperatura interna centrale',
                        status: {
                            sensorType: 'temperature',
                            value: internalTemp,
                            unit: 'C',
                        },
                    } as KseniaSensor;
                    this.deps.state.devices.set(sensorId, tempDevice);
                    this.deps.emitDeviceDiscovered(tempDevice);
                } else if (tempDevice.type === 'sensor') {
                    tempDevice.status.value = internalTemp;
                    this.deps.emitDeviceStatusUpdate(tempDevice);
                }

                this.applyPanelTemperatureFallback(internalTemp);
            }

            if (externalTemp !== undefined && !isNaN(externalTemp)) {
                const sensorId = 'sensor_system_temp_out';
                let tempDevice = this.deps.state.devices.get(sensorId);

                if (!tempDevice) {
                    tempDevice = {
                        id: sensorId,
                        type: 'sensor',
                        name: 'Temperatura Esterna',
                        description: 'Temperatura esterna centrale',
                        status: {
                            sensorType: 'temperature',
                            value: externalTemp,
                            unit: 'C',
                        },
                    } as KseniaSensor;
                    this.deps.state.devices.set(sensorId, tempDevice);
                    this.deps.emitDeviceDiscovered(tempDevice);
                } else if (tempDevice.type === 'sensor') {
                    tempDevice.status.value = externalTemp;
                    this.deps.emitDeviceStatusUpdate(tempDevice);
                }
            }

            if (this.deps.logLevel >= LogLevel.DEBUG) {
                this.deps.log.debug('System temperatures updated');
            }
        });
    }

    /**
     * The panel's internal temperature stands in only for a thermostat that has
     * no source at all, known only once the initial realtime has arrived: never reported in STATUS_TEMPERATURES and no mapped DOMUS
     * sensor that has reported. The panel sends those only when a value changes,
     * so a source that stays silent is a stable room, not a lost one.
     */
    private applyPanelTemperatureFallback(internalTemp: number): void {
        const state = this.deps.state;
        // Until the initial realtime (REALTIME_RES) has been applied nobody can
        // tell a thermostat without a source from one not reported yet.
        if (!state.hasCompletedInitialSync) return;
        for (const device of state.devices.values()) {
            if (device.type !== 'thermostat') continue;
            const thermostatOutputId = stripDevicePrefix(device.id);
            if (state.thermostatRealtimeByOutputId.has(thermostatOutputId)) continue;
            const mappedSensorId = state.domusThermostatConfig.enabled
                ? state.thermostatToDomus.get(thermostatOutputId)
                : undefined;
            if (mappedSensorId !== undefined && state.domusLatest.get(mappedSensorId)?.temp !== undefined) continue;
            if (updateThermostatStatus(device, { currentTemperature: internalTemp })) {
                this.deps.emitDeviceStatusUpdate(device);
            }
        }
    }
}
