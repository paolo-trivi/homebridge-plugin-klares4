import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform } from '../platform';
import type { KseniaSensor } from '../types';
import { PLUGIN_VERSION } from '../plugin-version';
import { sanitizeHapDisplayName } from '../display-name';
import { hasObservedState } from '../device-observation';

// HomeKit's ranges for each characteristic.
const clampTemperature = (value: number): number => Math.max(-270, Math.min(100, value));
const clampHumidity = (value: number): number => Math.max(0, Math.min(100, value));
const clampLux = (value: number): number => Math.max(0.0001, Math.min(100000, value));

/**
 * Sensor Accessory Handler
 * Handles HomeKit sensor services for Ksenia Lares4 sensors
 */
export class SensorAccessory {
    private service: Service;
    public device: KseniaSensor;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.device = accessory.context.device as KseniaSensor;

        const accessoryInfoService = this.accessory.getService(
            this.platform.Service.AccessoryInformation,
        );
        if (accessoryInfoService) {
            accessoryInfoService
                .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ksenia')
                .setCharacteristic(
                    this.platform.Characteristic.Model,
                    `Lares4 ${this.getSensorTypeLabel()}`,
                )
                .setCharacteristic(
                    this.platform.Characteristic.SerialNumber,
                    this.device.id || `lares4-${accessory.UUID.slice(0, 8)}`,
                )
                .setCharacteristic(this.platform.Characteristic.FirmwareRevision, PLUGIN_VERSION);
        }

        this.service = this.createSensorService();
        this.service.setCharacteristic(this.platform.Characteristic.Name, sanitizeHapDisplayName(this.device.name, this.device.id));
    }

    private createSensorService(): Service {
        switch (this.device.status.sensorType) {
            case 'temperature':
                return this.createTemperatureSensor();
            case 'humidity':
                return this.createHumiditySensor();
            case 'light':
                return this.createLightSensor();
            case 'motion':
                return this.createMotionSensor();
            case 'contact':
                return this.createContactSensor();
            default:
                return this.createTemperatureSensor();
        }
    }

    private createTemperatureSensor(): Service {
        const service =
            this.accessory.getService(this.platform.Service.TemperatureSensor) ??
            this.accessory.addService(this.platform.Service.TemperatureSensor);

        service
            .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .onGet(this.getCurrentTemperature.bind(this));

        return service;
    }

    private createHumiditySensor(): Service {
        const service =
            this.accessory.getService(this.platform.Service.HumiditySensor) ??
            this.accessory.addService(this.platform.Service.HumiditySensor);

        service
            .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
            .onGet(this.getCurrentHumidity.bind(this));

        return service;
    }

    private createLightSensor(): Service {
        const service =
            this.accessory.getService(this.platform.Service.LightSensor) ??
            this.accessory.addService(this.platform.Service.LightSensor);

        service
            .getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel)
            .onGet(this.getCurrentLightLevel.bind(this));

        return service;
    }

    private createMotionSensor(): Service {
        const service =
            this.accessory.getService(this.platform.Service.MotionSensor) ??
            this.accessory.addService(this.platform.Service.MotionSensor);

        service
            .getCharacteristic(this.platform.Characteristic.MotionDetected)
            .onGet(this.getMotionDetected.bind(this));

        return service;
    }

    private createContactSensor(): Service {
        const service =
            this.accessory.getService(this.platform.Service.ContactSensor) ??
            this.accessory.addService(this.platform.Service.ContactSensor);

        service
            .getCharacteristic(this.platform.Characteristic.ContactSensorState)
            .onGet(this.getContactState.bind(this));

        return service;
    }

    /**
     * The panel's reading. A sensor the panel has never reported (discovery only
     * carries placeholders such as 0 °C or 50 %) has no reading: HomeKit shows
     * "No Response" instead of a number that was never measured.
     */
    private reading(): number {
        const value = this.device.status.value;
        if (!hasObservedState(this.device) || typeof value !== 'number' || !Number.isFinite(value)) {
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
        }
        return value;
    }

    public async getCurrentTemperature(): Promise<CharacteristicValue> {
        return clampTemperature(this.reading());
    }

    public async getCurrentHumidity(): Promise<CharacteristicValue> {
        return clampHumidity(this.reading());
    }

    public async getCurrentLightLevel(): Promise<CharacteristicValue> {
        return clampLux(this.reading());
    }

    public async getMotionDetected(): Promise<CharacteristicValue> {
        return this.reading() > 0;
    }

    public async getContactState(): Promise<CharacteristicValue> {
        // 0 = contact detected (closed), 1 = contact not detected (open)
        return this.reading() > 0 ? 1 : 0;
    }

    private getSensorTypeLabel(): string {
        switch (this.device.status.sensorType) {
            case 'temperature':
                return 'Temperature Sensor';
            case 'humidity':
                return 'Humidity Sensor';
            case 'light':
                return 'Light Sensor';
            case 'motion':
                return 'Motion Sensor';
            case 'contact':
                return 'Contact Sensor';
            default:
                return 'Sensor';
        }
    }

    public updateStatus(newDevice: KseniaSensor): void {
        this.device = newDevice;

        // A placeholder is not a measurement: leave the characteristic as it is.
        if (!hasObservedState(this.device)) {
            this.platform.log.debug(`Sensor ${this.device.name}: no reading from the panel yet`);
            return;
        }
        const value = this.device.status.value;
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            this.platform.log.debug(`Sensor ${this.device.name}: ignoring a reading that is not a number`);
            return;
        }
        const { Characteristic } = this.platform;

        switch (this.device.status.sensorType) {
            case 'temperature':
                this.service.updateCharacteristic(Characteristic.CurrentTemperature, clampTemperature(value));
                break;
            case 'humidity':
                this.service.updateCharacteristic(Characteristic.CurrentRelativeHumidity, clampHumidity(value));
                break;
            case 'light':
                this.service.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, clampLux(value));
                break;
            case 'motion':
                this.service.updateCharacteristic(Characteristic.MotionDetected, value > 0);
                break;
            case 'contact':
                this.service.updateCharacteristic(Characteristic.ContactSensorState, value > 0 ? 1 : 0);
                break;
        }

        this.platform.log.debug(`Updated sensor ${this.device.name}: ${value}${this.device.status.unit ?? ''}`);
    }
}
