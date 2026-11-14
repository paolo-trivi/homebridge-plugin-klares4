import type {
    KseniaDevice,
    KseniaOutputStatusRaw,
    KseniaSensorStatusRaw,
    KseniaZoneStatusRaw,
    KseniaCover,
    KseniaLight,
    SensorStatus,
    ThermostatStatus,
    ZoneStatus,
} from '../types';
import type { Logger } from 'homebridge';
import { LogLevel } from '../log-levels';
import { kseniaModeToDomain } from '../thermostat-mode';
import { updateThermostatStatus } from '../thermostat-state';
import { normalizeDomusSensorId } from './domus-thermostat-mapper';
import { hasFreshThermostatRealtimeState } from './thermostat-status-updater';
import {
    mapCoverPosition,
    mapCoverState,
    parseFloatInRange,
    parseIntegerInRange,
    parseOnOff,
} from '../websocket/device-state-projector';
import { setBounded } from './bounded-map';
import { ZoneFieldReader } from './zone-status-reader';
import { forEachIsolated } from '../isolation';
import type { WebSocketClientState } from './types';

interface StatusUpdaterDeps {
    state: WebSocketClientState;
    log: Logger;
    logLevel: LogLevel;
    debugEnabled: boolean;
    emitDeviceStatusUpdate: (device: KseniaDevice) => void;
    observeOutputStatus?: (status: KseniaOutputStatusRaw) => void;
}

export class StatusUpdater {
    private readonly zoneFields: ZoneFieldReader;

    constructor(private readonly deps: StatusUpdaterDeps) {
        this.zoneFields = new ZoneFieldReader(deps.log);
    }

    public updateOutputStatuses(outputs: KseniaOutputStatusRaw[]): void {
        forEachIsolated(this.deps.log, 'STATUS_OUTPUTS entry', outputs, (output: KseniaOutputStatusRaw): void => {
            this.deps.observeOutputStatus?.(output);
            if (this.deps.logLevel >= LogLevel.DEBUG) {
                this.deps.log.debug(`Output update ${output.ID}: STA=${output.STA}, POS=${output.POS}, TPOS=${output.TPOS}`);
            }
            let matchedDevice = false;

            const lightDevice = this.deps.state.devices.get(`light_${output.ID}`);
            if (lightDevice && lightDevice.type === 'light') {
                matchedDevice = true;
                this.applyLightStatus(lightDevice, output);
            }

            const coverDevice = this.deps.state.devices.get(`cover_${output.ID}`);
            if (coverDevice && coverDevice.type === 'cover') {
                matchedDevice = true;
                this.applyCoverStatus(coverDevice, output);
            }

            const thermostatDevice = this.deps.state.devices.get(`thermostat_${output.ID}`);
            if (thermostatDevice && thermostatDevice.type === 'thermostat') {
                matchedDevice = true;
                const thermostatStatus = thermostatDevice.status as ThermostatStatus;
                const hasFreshRealtime = hasFreshThermostatRealtimeState(this.deps.state, output.ID);
                let updated = false;

                if (!hasFreshRealtime && output.TEMP_CURRENT !== undefined) {
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

                if (!hasFreshRealtime && output.TEMP_TARGET !== undefined) {
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

                if (!hasFreshRealtime && typeof output.MODE === 'string') {
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
                setBounded(this.deps.state.pendingOutputStatuses, output.ID, output);
            } else {
                this.deps.state.pendingOutputStatuses.delete(output.ID);
            }
        });
    }

    public updateSensorStatuses(sensors: KseniaSensorStatusRaw[]): void {
        forEachIsolated(this.deps.log, 'STATUS_BUS_HA_SENSORS entry', sensors, (sensor: KseniaSensorStatusRaw): void => {
            if (sensor.DOMUS) {
                const sensorId = normalizeDomusSensorId(sensor.ID);
                let matchedDevice = false;
                const parsedTemp = parseFloatInRange(sensor.DOMUS.TEM, -50, 100);
                const parsedHum = parseIntegerInRange(sensor.DOMUS.HUM, 0, 100);
                const parsedLight = parseIntegerInRange(sensor.DOMUS.LHT, 0, 100000);
                if (this.deps.logLevel >= LogLevel.DEBUG) {
                    this.deps.log.debug(
                        `Sensor update ${sensor.ID}: TEM=${sensor.DOMUS.TEM}C, HUM=${sensor.DOMUS.HUM}%, LHT=${sensor.DOMUS.LHT}lux`,
                    );
                }

                // A reading that is absent or invalid leaves the device as it was:
                // no emission, so a discovery placeholder never becomes "observed".
                for (const [prefix, value] of [
                    ['sensor_temp_', parsedTemp],
                    ['sensor_hum_', parsedHum],
                    ['sensor_light_', parsedLight],
                ] as const) {
                    const device = this.deps.state.devices.get(`${prefix}${sensorId}`);
                    if (!device || device.type !== 'sensor') continue;
                    matchedDevice = true;
                    if (value === undefined) continue;
                    (device.status as SensorStatus).value = value;
                    this.deps.emitDeviceStatusUpdate(device);
                }

                if (parsedTemp !== undefined || parsedHum !== undefined) {
                    this.deps.state.domusLatest.set(sensorId, {
                        temp: parsedTemp,
                        hum: parsedHum,
                        ts: Date.now(),
                    });
                }

                if (this.deps.state.domusThermostatConfig.enabled) {
                    for (const [thermostatOutputId, mappedSensorId] of this.deps.state.thermostatToDomus.entries()) {
                        if (mappedSensorId !== sensorId) {
                            continue;
                        }

                        const thermostatDevice = this.deps.state.devices.get(`thermostat_${thermostatOutputId}`);
                        if (!thermostatDevice || thermostatDevice.type !== 'thermostat') {
                            continue;
                        }

                        const hasFreshRealtime = hasFreshThermostatRealtimeState(
                            this.deps.state,
                            thermostatOutputId,
                        );
                        const changed = updateThermostatStatus(thermostatDevice, {
                            currentTemperature: hasFreshRealtime ? undefined : parsedTemp,
                            humidity: parsedHum,
                        });

                        if (changed) {
                            this.deps.emitDeviceStatusUpdate(thermostatDevice);
                        }
                    }
                }

                if (!matchedDevice) {
                    setBounded(this.deps.state.pendingSensorStatuses, sensorId, { ...sensor, ID: sensorId });
                } else {
                    this.deps.state.pendingSensorStatuses.delete(sensorId);
                }
            }
        });
    }

    public updateZoneStatuses(zones: KseniaZoneStatusRaw[]): void {
        forEachIsolated(this.deps.log, 'STATUS_ZONES entry', zones, (zone: KseniaZoneStatusRaw): void => {
            const zoneDevice = this.deps.state.devices.get(`zone_${zone.ID}`);
            if (zoneDevice && zoneDevice.type === 'zone') {
                if (this.zoneFields.apply(zoneDevice.status as ZoneStatus, zone)) {
                    this.deps.emitDeviceStatusUpdate(zoneDevice);
                }
                this.deps.state.pendingZoneStatuses.delete(zone.ID);
            } else {
                setBounded(this.deps.state.pendingZoneStatuses, zone.ID, zone);
            }
        });
    }

    private applyLightStatus(lightDevice: KseniaLight, output: KseniaOutputStatusRaw): void {
        const lightStatus = lightDevice.status;
        const on = parseOnOff(output.STA);
        const brightness = parseIntegerInRange(output.POS, 0, 100);
        if (on === undefined && brightness === undefined) {
            this.deps.log.debug(`Output ${output.ID}: no readable light state in this update, ignored`);
            return;
        }
        if (on !== undefined) {
            if (lightStatus.on !== on) {
                this.deps.log.info(`Light ${lightDevice.name} (Output ${output.ID}): ${on ? 'ON' : 'OFF'}`);
            }
            lightStatus.on = on;
        }
        if (brightness !== undefined) {
            lightStatus.brightness = brightness;
            lightStatus.dimmable = true;
        }
        this.deps.emitDeviceStatusUpdate(lightDevice);
    }

    private applyCoverStatus(coverDevice: KseniaCover, output: KseniaOutputStatusRaw): void {
        const coverStatus = coverDevice.status;
        const newPosition = mapCoverPosition(output.STA, output.POS);
        if (newPosition === undefined) {
            this.deps.log.debug(`Output ${output.ID}: no readable cover position in this update, ignored`);
            return;
        }
        if (coverStatus.position !== newPosition) {
            this.deps.log.info(`Cover ${coverDevice.name} (Output ${output.ID}): ${output.STA} position ${newPosition}%`);
        }
        coverStatus.position = newPosition;
        coverStatus.targetPosition = parseIntegerInRange(output.TPOS, 0, 100) ?? newPosition;
        coverStatus.state = mapCoverState(output.STA, output.POS, output.TPOS);
        this.deps.emitDeviceStatusUpdate(coverDevice);
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
