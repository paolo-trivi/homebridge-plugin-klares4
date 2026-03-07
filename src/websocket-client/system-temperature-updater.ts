import type { KseniaDevice, KseniaSensor } from '../types';
import type { Logger } from 'homebridge';
import { LogLevel } from '../log-levels';
import { updateThermostatStatus } from '../thermostat-state';
import { parseFloatInRange } from '../websocket/device-state-projector';
import type { SystemTemperatureData, WebSocketClientState } from './types';

interface SystemTemperatureUpdaterDeps {
    state: WebSocketClientState;
    log: Logger;
    logLevel: LogLevel;
    debugEnabled: boolean;
    emitDeviceDiscovered: (device: KseniaDevice) => void;
    emitDeviceStatusUpdate: (device: KseniaDevice) => void;
}

export class SystemTemperatureUpdater {
    constructor(private readonly deps: SystemTemperatureUpdaterDeps) {}

    public updateSystemTemperatures(systemData: SystemTemperatureData[]): void {
        systemData.forEach((system: SystemTemperatureData): void => {
            if (this.deps.debugEnabled) {
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

                this.deps.state.devices.forEach((device: KseniaDevice): void => {
                    if (device.type !== 'thermostat') {
                        return;
                    }

                    if (
                        device.status.targetTemperature === undefined ||
                        device.status.targetTemperature === null
                    ) {
                        updateThermostatStatus(device, {
                            targetTemperature: Math.round(internalTemp + 1),
                        });
                    }

                    updateThermostatStatus(device, {
                        currentTemperature: internalTemp,
                    });
                    this.deps.emitDeviceStatusUpdate(device);
                });
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
}
