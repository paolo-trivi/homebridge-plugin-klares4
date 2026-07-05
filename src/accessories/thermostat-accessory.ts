import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform, Lares4Config } from '../platform';
import type { KseniaThermostat } from '../types';
import { PLUGIN_VERSION } from '../plugin-version';
import { sanitizeHapDisplayName } from '../display-name';
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
    private readonly tempMin: number;
    private readonly tempMax: number;

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
                .setCharacteristic(
                    this.platform.Characteristic.SerialNumber,
                    this.device.id || `lares4-${accessory.UUID.slice(0, 8)}`,
                )
                .setCharacteristic(this.platform.Characteristic.FirmwareRevision, PLUGIN_VERSION);
        }

        this.service =
            this.accessory.getService(this.platform.Service.Thermostat) ??
            this.accessory.addService(this.platform.Service.Thermostat);

        this.service.setCharacteristic(this.platform.Characteristic.Name, sanitizeHapDisplayName(this.device.name, this.device.id));

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
        this.tempMin = tempDefaults.min ?? 10;
        this.tempMax = tempDefaults.max ?? 38;
        this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature).setProps({
            minValue: this.tempMin,
            maxValue: this.tempMax,
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
            // Use last persisted value from cache to avoid showing 0°C to Matter at startup.
            const lastKnown = this.accessory.context.lastKnownTemp as number | undefined;
            const fallback = lastKnown ?? 21;
            this.platform.log.warn(
                `${this.device.name}: Current temperature not available, using ${fallback}C`,
            );
            return Math.max(-270, Math.min(100, fallback));
        }
        return Math.max(-270, Math.min(100, this.device.currentTemperature));
    }

    public async getTargetTemperature(): Promise<CharacteristicValue> {
        if (
            this.device.targetTemperature === undefined ||
            this.device.targetTemperature === null
        ) {
            const configTarget =
                (this.platform.config as Lares4Config).temperatureDefaults?.target ?? 21;
            // Clamp the default to the configured bounds so Matter bounds validation passes.
            const defaultTemp = Math.max(this.tempMin, Math.min(this.tempMax, configTarget));
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
        // Persist so the next cold-start can return a realistic fallback from cache.
        if (newDevice.currentTemperature !== undefined && newDevice.currentTemperature !== null) {
            this.accessory.context.lastKnownTemp = newDevice.currentTemperature;
        }
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
            device.status.hvacOutputActive,
        );
    }
}
