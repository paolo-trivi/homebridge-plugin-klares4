import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform } from '../platform';
import type { KseniaLight, LightStatus } from '../types';

/**
 * Light Accessory Handler
 * Handles HomeKit Lightbulb service for Ksenia Lares4 lights
 */
export class LightAccessory {
    private service: Service;
    public device: KseniaLight;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.device = accessory.context.device as KseniaLight;

        const accessoryInfoService = this.accessory.getService(
            this.platform.Service.AccessoryInformation,
        );
        if (accessoryInfoService) {
            accessoryInfoService
                .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ksenia')
                .setCharacteristic(this.platform.Characteristic.Model, 'Lares4 Light')
                .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
                .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '2.0.0');
        }

        this.service =
            this.accessory.getService(this.platform.Service.Lightbulb) ??
            this.accessory.addService(this.platform.Service.Lightbulb);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

        this.service
            .getCharacteristic(this.platform.Characteristic.On)
            .onSet(this.setOn.bind(this))
            .onGet(this.getOn.bind(this));

        if (this.device.status?.dimmable) {
            this.service
                .getCharacteristic(this.platform.Characteristic.Brightness)
                .onSet(this.setBrightness.bind(this))
                .onGet(this.getBrightness.bind(this));
        }
    }

    public async setOn(value: CharacteristicValue): Promise<void> {
        const on = value as boolean;

        try {
            await this.platform.wsClient?.switchLight(this.device.id, on);
            this.device.status.on = on;
            this.platform.log.info(`${this.device.name}: ${on ? 'On' : 'Off'}`);
        } catch (error: unknown) {
            this.platform.log.error(
                `Light control error ${this.device.name}:`,
                error instanceof Error ? error.message : String(error),
            );
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
        }
    }

    public async getOn(): Promise<CharacteristicValue> {
        return this.device.status?.on ?? false;
    }

    public async setBrightness(value: CharacteristicValue): Promise<void> {
        const brightness = value as number;

        if (!this.device.status?.dimmable) {
            return;
        }

        try {
            await this.platform.wsClient?.dimLight(this.device.id, brightness);
            this.device.status.brightness = brightness;
            this.device.status.on = brightness > 0;

            this.service.updateCharacteristic(
                this.platform.Characteristic.On,
                this.device.status.on,
            );

            this.platform.log.info(`${this.device.name}: Brightness ${brightness}%`);
        } catch (error: unknown) {
            this.platform.log.error(
                `Dimmer error ${this.device.name}:`,
                error instanceof Error ? error.message : String(error),
            );
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
        }
    }

    public async getBrightness(): Promise<CharacteristicValue> {
        return this.device.status?.brightness ?? (this.device.status?.on ? 100 : 0);
    }

    public updateStatus(newDevice: KseniaLight): void {
        this.device = newDevice;

        this.service.updateCharacteristic(
            this.platform.Characteristic.On,
            this.device.status?.on ?? false,
        );

        if (this.device.status?.dimmable && this.device.status?.brightness !== undefined) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.Brightness,
                this.device.status.brightness,
            );
        }

        this.platform.log.debug(
            `Updated light state ${this.device.name}: ${this.device.status?.on ? 'ON' : 'OFF'}`,
        );
    }
}