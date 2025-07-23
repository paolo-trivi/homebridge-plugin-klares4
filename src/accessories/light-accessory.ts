import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform } from '../platform';
import type { KseniaDevice } from '../types';

export class LightAccessory {
    private service: Service;
    private device: KseniaDevice;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.device = accessory.context.device as KseniaDevice;

        // Imposta le informazioni dell'accessorio
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ksenia')
            .setCharacteristic(this.platform.Characteristic.Model, 'Lares4 Light')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
            .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '2.0.0');

        // Ottieni o crea il servizio Lightbulb
        this.service = this.accessory.getService(this.platform.Service.Lightbulb)
            || this.accessory.addService(this.platform.Service.Lightbulb);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

        // Imposta gli handlers per le caratteristiche
        this.service.getCharacteristic(this.platform.Characteristic.On)
            .onSet(this.setOn.bind(this))
            .onGet(this.getOn.bind(this));

        // Se la luce è dimmerabile, aggiungi la caratteristica Brightness
        if (this.device.status?.dimmable) {
            this.service.getCharacteristic(this.platform.Characteristic.Brightness)
                .onSet(this.setBrightness.bind(this))
                .onGet(this.getBrightness.bind(this));
        }
    }

    async setOn(value: CharacteristicValue): Promise<void> {
        const on = value as boolean;

        try {
            await this.platform.wsClient?.switchLight(this.device.id, on);
            this.device.status.on = on;
            this.platform.log.info(`💡 ${this.device.name}: ${on ? 'Accesa' : 'Spenta'}`);
        } catch (error) {
            this.platform.log.error(`❌ Errore controllo luce ${this.device.name}:`, error);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async getOn(): Promise<CharacteristicValue> {
        return this.device.status?.on || false;
    }

    async setBrightness(value: CharacteristicValue): Promise<void> {
        const brightness = value as number;

        if (!this.device.status?.dimmable) {
            return;
        }

        try {
            await this.platform.wsClient?.dimLight(this.device.id, brightness);
            this.device.status.brightness = brightness;
            this.device.status.on = brightness > 0;

            // Aggiorna anche la caratteristica On
            this.service.updateCharacteristic(this.platform.Characteristic.On, this.device.status.on);

            this.platform.log.info(`💡 ${this.device.name}: Luminosità ${brightness}%`);
        } catch (error) {
            this.platform.log.error(`❌ Errore dimmer luce ${this.device.name}:`, error);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async getBrightness(): Promise<CharacteristicValue> {
        return this.device.status?.brightness || (this.device.status?.on ? 100 : 0);
    }

    // Metodo per aggiornare lo stato dall'esterno (aggiornamenti real-time)
    updateStatus(newDevice: KseniaDevice): void {
        this.device = newDevice;

        // Aggiorna le caratteristiche
        this.service.updateCharacteristic(this.platform.Characteristic.On, this.device.status?.on || false);

        if (this.device.status?.dimmable && this.device.status?.brightness !== undefined) {
            this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.device.status.brightness);
        }

        this.platform.log.debug(`🔄 Aggiornato stato luce ${this.device.name}: ${this.device.status?.on ? 'ON' : 'OFF'}`);
    }
} 