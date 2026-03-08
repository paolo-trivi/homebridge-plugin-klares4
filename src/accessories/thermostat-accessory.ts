import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform, Lares4Config } from '../platform';
import type { KseniaThermostat } from '../types';
import {
    deriveHomeKitCurrentState,
    domainModeToHomeKitTarget,
    homeKitTargetToDomainMode,
} from '../thermostat-mode';
import { syncThermostatTopLevelFromStatus, updateThermostatStatus } from '../thermostat-state';

/**
 * Thermostat Accessory Handler
 * Handles HomeKit Thermostat service for Ksenia Lares4 thermostats
 */
export class ThermostatAccessory {
    private service: Service;
    public device: KseniaThermostat;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.device = accessory.context.device as KseniaThermostat;
        syncThermostatTopLevelFromStatus(this.device);

        const accessoryInfoService = this.accessory.getService(
            this.platform.Service.AccessoryInformation,
        );
        if (accessoryInfoService) {
            accessoryInfoService
                .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ksenia')
                .setCharacteristic(this.platform.Characteristic.Model, 'Lares4 Thermostat')
                .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
                .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '2.0.0');
        }

        this.service =
            this.accessory.getService(this.platform.Service.Thermostat) ??
            this.accessory.addService(this.platform.Service.Thermostat);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

        this.service
            .getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
            .onGet(this.getCurrentHeatingCoolingState.bind(this));

        this.service
            .getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
            .onSet(this.setTargetHeatingCoolingState.bind(this))
            .onGet(this.getTargetHeatingCoolingState.bind(this));

        this.service
            .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .onGet(this.getCurrentTemperature.bind(this));

        this.service
            .getCharacteristic(this.platform.Characteristic.TargetTemperature)
            .onSet(this.setTargetTemperature.bind(this))
            .onGet(this.getTargetTemperature.bind(this));

        this.service
            .getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
            .onGet(this.getTemperatureDisplayUnits.bind(this));

        if (this.device.humidity !== undefined) {
            this.service
                .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
                .onGet(this.getCurrentRelativeHumidity.bind(this));
        }

        const tempDefaults = (this.platform.config as Lares4Config).temperatureDefaults ?? {};
        this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature).setProps({
            minValue: tempDefaults.min ?? 10,
            maxValue: tempDefaults.max ?? 38,
            minStep: tempDefaults.step ?? 0.5,
        });

        this.updateCharacteristics();
    }

    public async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
        return this.deriveCurrentState(this.device);
    }

    public async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
        return domainModeToHomeKitTarget(this.device.mode);
    }

    public async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
        const newMode = homeKitTargetToDomainMode(value as number);

        try {
            await this.platform.wsClient?.setThermostatMode(this.device.id, newMode);
            updateThermostatStatus(this.device, { mode: newMode });

            this.platform.log.info(`${this.device.name}: Mode ${newMode}`);
        } catch (error: unknown) {
            this.platform.log.error(
                `Thermostat control error ${this.device.name}:`,
                error instanceof Error ? error.message : String(error),
            );
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
        }
    }

    public async getCurrentTemperature(): Promise<CharacteristicValue> {
        if (
            this.device.currentTemperature === undefined ||
            this.device.currentTemperature === null
        ) {
            this.platform.log.warn(`${this.device.name}: Current temperature not available`);
            return 0;
        }
        return Math.max(-270, Math.min(100, this.device.currentTemperature));
    }

    public async getTargetTemperature(): Promise<CharacteristicValue> {
        if (
            this.device.targetTemperature === undefined ||
            this.device.targetTemperature === null
        ) {
            const defaultTemp =
                (this.platform.config as Lares4Config).temperatureDefaults?.target ?? 21;
            this.platform.log.warn(
                `${this.device.name}: Target temperature not available, using ${defaultTemp}C as default`,
            );
            return defaultTemp;
        }
        return this.device.targetTemperature;
    }

    public async setTargetTemperature(value: CharacteristicValue): Promise<void> {
        const targetTemperature = value as number;

        try {
            await this.platform.wsClient?.setThermostatTemperature(this.device.id, targetTemperature);
            updateThermostatStatus(this.device, { targetTemperature });

            this.platform.log.info(`${this.device.name}: Target temperature ${targetTemperature}C`);
        } catch (error: unknown) {
            this.platform.log.error(
                `Thermostat temperature error ${this.device.name}:`,
                error instanceof Error ? error.message : String(error),
            );
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
        }
    }

    public async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
        return 0; // Celsius
    }

    public async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
        if (this.device.humidity !== undefined) {
            return Math.max(0, Math.min(100, this.device.humidity));
        }
        return 50; // Default value
    }

    private updateCharacteristics(): void {
        const currentState = this.deriveCurrentState(this.device);
        const targetState = this.deriveTargetState(this.device.mode);

        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentHeatingCoolingState,
            currentState,
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.TargetHeatingCoolingState,
            targetState,
        );

        const currentTemp =
            this.device.currentTemperature !== undefined &&
                this.device.currentTemperature !== null
                ? Math.max(-270, Math.min(100, this.device.currentTemperature))
                : 0;

        const defaultTemp =
            (this.platform.config as Lares4Config).temperatureDefaults?.target ?? 21;
        const targetTemp =
            this.device.targetTemperature !== undefined &&
                this.device.targetTemperature !== null
                ? this.device.targetTemperature
                : defaultTemp;

        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature,
            currentTemp,
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.TargetTemperature,
            targetTemp,
        );

        if (this.device.humidity !== undefined) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.CurrentRelativeHumidity,
                Math.max(0, Math.min(100, this.device.humidity)),
            );
        }
    }

    public updateStatus(newDevice: KseniaThermostat): void {
        syncThermostatTopLevelFromStatus(newDevice);
        this.device = newDevice;
        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature,
            Math.max(-270, Math.min(100, newDevice.currentTemperature)),
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.TargetTemperature,
            newDevice.targetTemperature,
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.TargetHeatingCoolingState,
            domainModeToHomeKitTarget(newDevice.mode),
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentHeatingCoolingState,
            deriveHomeKitCurrentState(
                newDevice.mode,
                newDevice.currentTemperature,
                newDevice.targetTemperature,
            ),
        );
        if (newDevice.humidity !== undefined) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.CurrentRelativeHumidity,
                Math.max(0, Math.min(100, newDevice.humidity)),
            );
        }

        this.platform.log.debug(
            `Updated thermostat ${this.device.name}: ${this.device.currentTemperature}C -> ${this.device.targetTemperature}C (${this.device.mode})`,
        );
    }

    private deriveTargetState(mode: 'off' | 'heat' | 'cool' | 'auto'): 0 | 1 | 2 | 3 {
        return domainModeToHomeKitTarget(mode);
    }

    private deriveCurrentState(device: KseniaThermostat): 0 | 1 | 2 {
        return deriveHomeKitCurrentState(
            device.mode,
            device.currentTemperature,
            device.targetTemperature,
        );
    }
}
