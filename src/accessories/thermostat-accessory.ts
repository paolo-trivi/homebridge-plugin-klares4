import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform, Lares4Config } from '../platform';
import type { KseniaThermostat } from '../types';
import {
    deriveHomeKitCurrentState,
    domainModeToHomeKitTarget,
    homeKitTargetToDomainMode,
} from '../thermostat-mode';
import { syncThermostatTopLevelFromStatus, updateThermostatStatus } from '../thermostat-state';
import { getCachedCharacteristicNumber } from './characteristic-utils';
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
        return deriveHomeKitCurrentState(
            this.device.mode,
            this.device.currentTemperature,
            this.device.targetTemperature,
        );
    }

    public async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
        return domainModeToHomeKitTarget(this.device.mode);
    }

    public async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
        const newMode = homeKitTargetToDomainMode(value as number);

        try {
            if (!this.platform.wsClient) {
                throw new Error('WebSocket client not initialized');
            }
            await this.platform.wsClient.setThermostatMode(this.device.id, newMode);
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
            typeof this.device.currentTemperature === 'number' &&
            Number.isFinite(this.device.currentTemperature)
        ) {
            return Math.max(-270, Math.min(100, this.device.currentTemperature));
        }

        const cachedCurrent = getCachedCharacteristicNumber(
            this.service,
            this.platform.Characteristic.CurrentTemperature,
            -270,
            100,
        );
        if (cachedCurrent !== undefined) {
            return cachedCurrent;
        }

        const targetFallback = await this.getTargetTemperature();
        this.platform.log.warn(
            `${this.device.name}: Current temperature not available, fallback to target value`,
        );
        return Math.max(-270, Math.min(100, Number(targetFallback)));
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
            if (!this.platform.wsClient) {
                throw new Error('WebSocket client not initialized');
            }
            await this.platform.wsClient.setThermostatTemperature(this.device.id, targetTemperature);
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
        if (
            typeof this.device.humidity === 'number' &&
            Number.isFinite(this.device.humidity)
        ) {
            return Math.max(0, Math.min(100, this.device.humidity));
        }

        const cachedHumidity = getCachedCharacteristicNumber(
            this.service,
            this.platform.Characteristic.CurrentRelativeHumidity,
            0,
            100,
        );
        if (cachedHumidity !== undefined) {
            return cachedHumidity;
        }

        throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
    }

    private updateCharacteristics(): void {
        const currentState = deriveHomeKitCurrentState(
            this.device.mode,
            this.device.currentTemperature,
            this.device.targetTemperature,
        );
        const targetState = domainModeToHomeKitTarget(this.device.mode);

        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentHeatingCoolingState,
            currentState,
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.TargetHeatingCoolingState,
            targetState,
        );

        const currentTemp =
            typeof this.device.currentTemperature === 'number' &&
                Number.isFinite(this.device.currentTemperature)
                ? Math.max(-270, Math.min(100, this.device.currentTemperature))
                : getCachedCharacteristicNumber(
                    this.service,
                    this.platform.Characteristic.CurrentTemperature,
                    -270,
                    100,
                );

        const defaultTemp =
            (this.platform.config as Lares4Config).temperatureDefaults?.target ?? 21;
        const targetTemp =
            typeof this.device.targetTemperature === 'number' &&
                Number.isFinite(this.device.targetTemperature)
                ? this.device.targetTemperature
                : defaultTemp;
        const resolvedCurrentTemp = currentTemp ?? targetTemp;

        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature,
            resolvedCurrentTemp,
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
        const currentTemp =
            typeof newDevice.currentTemperature === 'number' &&
            Number.isFinite(newDevice.currentTemperature)
                ? Math.max(-270, Math.min(100, newDevice.currentTemperature))
                : getCachedCharacteristicNumber(
                    this.service,
                    this.platform.Characteristic.CurrentTemperature,
                    -270,
                    100,
                );
        const targetTemp =
            typeof newDevice.targetTemperature === 'number' &&
            Number.isFinite(newDevice.targetTemperature)
                ? newDevice.targetTemperature
                : ((this.platform.config as Lares4Config).temperatureDefaults?.target ?? 21);
        const resolvedCurrentTemp = currentTemp ?? targetTemp;

        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature,
            resolvedCurrentTemp,
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.TargetTemperature,
            targetTemp,
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.TargetHeatingCoolingState,
            domainModeToHomeKitTarget(newDevice.mode),
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentHeatingCoolingState,
            deriveHomeKitCurrentState(
                newDevice.mode,
                resolvedCurrentTemp,
                targetTemp,
            ),
        );
        if (typeof newDevice.humidity === 'number' && Number.isFinite(newDevice.humidity)) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.CurrentRelativeHumidity,
                Math.max(0, Math.min(100, newDevice.humidity)),
            );
        }

        this.platform.log.debug(
            `Updated thermostat ${this.device.name}: ${this.device.currentTemperature}C -> ${this.device.targetTemperature}C (${this.device.mode})`,
        );
    }

}
