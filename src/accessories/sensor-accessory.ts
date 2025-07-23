import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform } from '../platform';
import type { KseniaSensor } from '../types';

export class SensorAccessory {
    private service: Service;
    private device: KseniaSensor;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.device = accessory.context.device as KseniaSensor;

        // Imposta le informazioni dell'accessorio
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ksenia')
            .setCharacteristic(this.platform.Characteristic.Model, `Lares4 ${this.getSensorTypeLabel()}`)
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
            .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '2.0.0');

        // Crea il servizio appropriato in base al tipo di sensore
        this.service = this.createSensorService();
        this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);
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
                // Default a temperature sensor
                return this.createTemperatureSensor();
        }
    }

    private createTemperatureSensor(): Service {
        const service = this.accessory.getService(this.platform.Service.TemperatureSensor)
            || this.accessory.addService(this.platform.Service.TemperatureSensor);

        service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .onGet(this.getCurrentTemperature.bind(this));

        return service;
    }

    private createHumiditySensor(): Service {
        const service = this.accessory.getService(this.platform.Service.HumiditySensor)
            || this.accessory.addService(this.platform.Service.HumiditySensor);

        service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
            .onGet(this.getCurrentHumidity.bind(this));

        return service;
    }

    private createLightSensor(): Service {
        const service = this.accessory.getService(this.platform.Service.LightSensor)
            || this.accessory.addService(this.platform.Service.LightSensor);

        service.getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel)
            .onGet(this.getCurrentLightLevel.bind(this));

        return service;
    }

    private createMotionSensor(): Service {
        const service = this.accessory.getService(this.platform.Service.MotionSensor)
            || this.accessory.addService(this.platform.Service.MotionSensor);

        service.getCharacteristic(this.platform.Characteristic.MotionDetected)
            .onGet(this.getMotionDetected.bind(this));

        return service;
    }

    private createContactSensor(): Service {
        const service = this.accessory.getService(this.platform.Service.ContactSensor)
            || this.accessory.addService(this.platform.Service.ContactSensor);

        service.getCharacteristic(this.platform.Characteristic.ContactSensorState)
            .onGet(this.getContactState.bind(this));

        return service;
    }

    async getCurrentTemperature(): Promise<CharacteristicValue> {
        const value = this.device.status.value;
        // HomeKit richiede temperature tra -270 e 100°C
        return Math.max(-270, Math.min(100, value));
    }

    async getCurrentHumidity(): Promise<CharacteristicValue> {
        const value = this.device.status.value;
        // HomeKit richiede umidità tra 0 e 100%
        return Math.max(0, Math.min(100, value));
    }

    async getCurrentLightLevel(): Promise<CharacteristicValue> {
        const value = this.device.status.value;
        // HomeKit richiede lux tra 0.0001 e 100000
        return Math.max(0.0001, Math.min(100000, value));
    }

    async getMotionDetected(): Promise<CharacteristicValue> {
        return this.device.status.value > 0;
    }

    async getContactState(): Promise<CharacteristicValue> {
        // 0 = contact detected (chiuso), 1 = contact not detected (aperto)
        return this.device.status.value > 0 ? 1 : 0;
    }

    private getSensorTypeLabel(): string {
        switch (this.device.status.sensorType) {
            case 'temperature': return 'Temperature Sensor';
            case 'humidity': return 'Humidity Sensor';
            case 'light': return 'Light Sensor';
            case 'motion': return 'Motion Sensor';
            case 'contact': return 'Contact Sensor';
            default: return 'Sensor';
        }
    }

    // Metodo per aggiornare lo stato dall'esterno (aggiornamenti real-time)
    updateStatus(newDevice: KseniaSensor): void {
        this.device = newDevice;

        // Aggiorna la caratteristica appropriata in base al tipo di sensore
        switch (this.device.status.sensorType) {
            case 'temperature':
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentTemperature,
                    Math.max(-270, Math.min(100, this.device.status.value))
                );
                break;
            case 'humidity':
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentRelativeHumidity,
                    Math.max(0, Math.min(100, this.device.status.value))
                );
                break;
            case 'light':
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentAmbientLightLevel,
                    Math.max(0.0001, Math.min(100000, this.device.status.value))
                );
                break;
            case 'motion':
                this.service.updateCharacteristic(
                    this.platform.Characteristic.MotionDetected,
                    this.device.status.value > 0
                );
                break;
            case 'contact':
                this.service.updateCharacteristic(
                    this.platform.Characteristic.ContactSensorState,
                    this.device.status.value > 0 ? 1 : 0
                );
                break;
        }

        this.platform.log.debug(`🔄 Aggiornato sensore ${this.device.name}: ${this.device.status.value}${this.device.status.unit || ''}`);
    }
} 