import type {
    KseniaDevice,
    KseniaOutputStatusRaw,
    KseniaSensorStatusRaw,
    KseniaZoneStatusRaw,
    CoverStatus,
    LightStatus,
    SensorStatus,
    ThermostatStatus,
    ZoneStatus,
} from '../types';
import type { Logger } from 'homebridge';
import { LogLevel } from '../log-levels';
import { kseniaModeToDomain } from '../thermostat-mode';
import { updateThermostatStatus } from '../thermostat-state';
import {
    mapCoverPosition,
    mapCoverState,
    parseFloatInRange,
    parseIntegerInRange,
} from '../websocket/device-state-projector';
import type { WebSocketClientState } from './types';

interface StatusUpdaterDeps {
    state: WebSocketClientState;
    log: Logger;
    logLevel: LogLevel;
    debugEnabled: boolean;
    emitDeviceStatusUpdate: (device: KseniaDevice) => void;
}

export class StatusUpdater {
    constructor(private readonly deps: StatusUpdaterDeps) {}

    public updateOutputStatuses(outputs: KseniaOutputStatusRaw[]): void {
        outputs.forEach((output: KseniaOutputStatusRaw): void => {
            this.deps.log.debug(
                `Output update ${output.ID}: STA=${output.STA}, POS=${output.POS}, TPOS=${output.TPOS}`,
            );
            let matchedDevice = false;

            const lightDevice = this.deps.state.devices.get(`light_${output.ID}`);
            if (lightDevice && lightDevice.type === 'light') {
                matchedDevice = true;
                const lightStatus = lightDevice.status as LightStatus;
                const wasOn = lightStatus.on;
                lightStatus.on = output.STA === 'ON';
                if (output.POS !== undefined) {
                    const brightness = parseIntegerInRange(output.POS, 0, 100);
                    if (brightness !== undefined) {
                        lightStatus.brightness = brightness;
                        lightStatus.dimmable = true;
                    }
                }
                if (wasOn !== (output.STA === 'ON')) {
                    this.deps.log.info(
                        `Light ${lightDevice.name} (Output ${output.ID}): ${output.STA === 'ON' ? 'ON' : 'OFF'}`,
                    );
                }
                this.deps.emitDeviceStatusUpdate(lightDevice);
            }

            const coverDevice = this.deps.state.devices.get(`cover_${output.ID}`);
            if (coverDevice && coverDevice.type === 'cover') {
                matchedDevice = true;
                const coverStatus = coverDevice.status as CoverStatus;
                const oldPos = coverStatus.position;
                const newPosition = mapCoverPosition(output.STA, output.POS);
                coverStatus.position = newPosition;
                coverStatus.targetPosition =
                    parseIntegerInRange(output.TPOS ?? output.POS, 0, 100) ?? newPosition;
                coverStatus.state = mapCoverState(output.STA, output.POS, output.TPOS);

                if (oldPos !== newPosition) {
                    this.deps.log.info(
                        `Cover ${coverDevice.name} (Output ${output.ID}): ${output.STA} position ${newPosition}%`,
                    );
                }
                this.deps.emitDeviceStatusUpdate(coverDevice);
            }

            const thermostatDevice = this.deps.state.devices.get(`thermostat_${output.ID}`);
            if (thermostatDevice && thermostatDevice.type === 'thermostat') {
                matchedDevice = true;
                const thermostatStatus = thermostatDevice.status as ThermostatStatus;
                let updated = false;

                if (output.TEMP_CURRENT !== undefined) {
                    const oldCurrentTemp = thermostatStatus.currentTemperature;
                    const newCurrentTemp = parseFloatInRange(output.TEMP_CURRENT, -50, 100);
                    if (newCurrentTemp !== undefined) {
                        updateThermostatStatus(thermostatDevice, {
                            currentTemperature: newCurrentTemp,
                        });
                        if (oldCurrentTemp !== newCurrentTemp) {
                            this.deps.log.info(`${thermostatDevice.name}: Current temperature ${newCurrentTemp}C`);
                            updated = true;
                        }
                    }
                }

                if (output.TEMP_TARGET !== undefined) {
                    const oldTargetTemp = thermostatStatus.targetTemperature;
                    const newTargetTemp = parseFloatInRange(output.TEMP_TARGET, 5, 40);
                    if (newTargetTemp !== undefined) {
                        updateThermostatStatus(thermostatDevice, {
                            targetTemperature: newTargetTemp,
                        });
                        if (oldTargetTemp !== newTargetTemp) {
                            this.deps.log.info(`${thermostatDevice.name}: Target temperature ${newTargetTemp}C`);
                            updated = true;
                        }
                    }
                }

                if (output.MODE !== undefined) {
                    const oldMode = thermostatStatus.mode;
                    const newMode = kseniaModeToDomain(output.MODE);
                    updateThermostatStatus(thermostatDevice, {
                        mode: newMode,
                    });
                    if (oldMode !== newMode) {
                        this.deps.log.info(`${thermostatDevice.name}: Mode ${newMode}`);
                        updated = true;
                    }
                }

                if (updated) {
                    this.deps.emitDeviceStatusUpdate(thermostatDevice);
                } else if (this.deps.debugEnabled) {
                    this.deps.log.debug(`Debug thermostat ${output.ID}: ${JSON.stringify(output)}`);
                }
            }

            if (!matchedDevice) {
                this.deps.state.pendingOutputStatuses.set(output.ID, output);
            } else {
                this.deps.state.pendingOutputStatuses.delete(output.ID);
            }
        });
    }

    public updateSensorStatuses(sensors: KseniaSensorStatusRaw[]): void {
        sensors.forEach((sensor: KseniaSensorStatusRaw): void => {
            if (sensor.DOMUS) {
                let matchedDevice = false;
                const parsedTemp = parseFloatInRange(sensor.DOMUS.TEM, -50, 100);
                const parsedHum = parseIntegerInRange(sensor.DOMUS.HUM, 0, 100);
                const parsedLight = parseIntegerInRange(sensor.DOMUS.LHT, 0, 100000);
                if (this.deps.logLevel >= LogLevel.DEBUG) {
                    this.deps.log.debug(
                        `Sensor update ${sensor.ID}: TEM=${sensor.DOMUS.TEM}C, HUM=${sensor.DOMUS.HUM}%, LHT=${sensor.DOMUS.LHT}lux`,
                    );
                }

                const tempDevice = this.deps.state.devices.get(`sensor_temp_${sensor.ID}`);
                if (tempDevice && tempDevice.type === 'sensor') {
                    matchedDevice = true;
                    const tempStatus = tempDevice.status as SensorStatus;
                    if (parsedTemp !== undefined) {
                        tempStatus.value = parsedTemp;
                    }
                    this.deps.emitDeviceStatusUpdate(tempDevice);
                }

                const humDevice = this.deps.state.devices.get(`sensor_hum_${sensor.ID}`);
                if (humDevice && humDevice.type === 'sensor') {
                    matchedDevice = true;
                    const humStatus = humDevice.status as SensorStatus;
                    if (parsedHum !== undefined) {
                        humStatus.value = parsedHum;
                    }
                    this.deps.emitDeviceStatusUpdate(humDevice);
                }

                const lightSensorDevice = this.deps.state.devices.get(`sensor_light_${sensor.ID}`);
                if (lightSensorDevice && lightSensorDevice.type === 'sensor') {
                    matchedDevice = true;
                    const lightStatus = lightSensorDevice.status as SensorStatus;
                    if (parsedLight !== undefined) {
                        lightStatus.value = parsedLight;
                    }
                    this.deps.emitDeviceStatusUpdate(lightSensorDevice);
                }

                if (parsedTemp !== undefined || parsedHum !== undefined) {
                    this.deps.state.domusLatest.set(sensor.ID, {
                        temp: parsedTemp,
                        hum: parsedHum,
                        ts: Date.now(),
                    });
                }

                if (this.deps.state.domusThermostatConfig.enabled) {
                    for (const [thermostatOutputId, mappedSensorId] of this.deps.state.thermostatToDomus.entries()) {
                        if (mappedSensorId !== sensor.ID) {
                            continue;
                        }

                        const thermostatDevice = this.deps.state.devices.get(`thermostat_${thermostatOutputId}`);
                        if (!thermostatDevice || thermostatDevice.type !== 'thermostat') {
                            continue;
                        }

                        const changed = updateThermostatStatus(thermostatDevice, {
                            currentTemperature: parsedTemp,
                            humidity: parsedHum,
                        });

                        if (changed) {
                            this.deps.emitDeviceStatusUpdate(thermostatDevice);
                        }
                    }
                }

                if (!matchedDevice) {
                    this.deps.state.pendingSensorStatuses.set(sensor.ID, sensor);
                } else {
                    this.deps.state.pendingSensorStatuses.delete(sensor.ID);
                }
            }
        });
    }

    public updateZoneStatuses(zones: KseniaZoneStatusRaw[]): void {
        zones.forEach((zone: KseniaZoneStatusRaw): void => {
            const zoneDevice = this.deps.state.devices.get(`zone_${zone.ID}`);
            if (zoneDevice && zoneDevice.type === 'zone') {
                const zoneStatus = zoneDevice.status as ZoneStatus;
                zoneStatus.open = zone.STA === 'A';
                zoneStatus.bypassed = zone.BYP === 'YES';
                zoneStatus.armed = zone.A === 'Y';
                zoneStatus.fault = zone.FM === 'T';

                this.deps.emitDeviceStatusUpdate(zoneDevice);
                this.deps.state.pendingZoneStatuses.delete(zone.ID);
            } else {
                this.deps.state.pendingZoneStatuses.set(zone.ID, zone);
            }
        });
    }

    public applyPendingOutputStatus(outputId: string): void {
        const pendingStatus = this.deps.state.pendingOutputStatuses.get(outputId);
        if (pendingStatus) {
            this.deps.state.pendingOutputStatuses.delete(outputId);
            this.updateOutputStatuses([pendingStatus]);
        }
    }

    public applyPendingSensorStatus(sensorId: string): void {
        const pendingStatus = this.deps.state.pendingSensorStatuses.get(sensorId);
        if (pendingStatus) {
            this.deps.state.pendingSensorStatuses.delete(sensorId);
            this.updateSensorStatuses([pendingStatus]);
        }
    }

    public applyPendingZoneStatus(zoneId: string): void {
        const pendingStatus = this.deps.state.pendingZoneStatuses.get(zoneId);
        if (pendingStatus) {
            this.deps.state.pendingZoneStatuses.delete(zoneId);
            this.updateZoneStatuses([pendingStatus]);
        }
    }
}
