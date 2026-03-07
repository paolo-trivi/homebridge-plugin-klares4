import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform } from '../platform';
import type { KseniaGate } from '../types';

/**
 * Gate Accessory Handler
 * Handles HomeKit Switch service for Ksenia Lares4 monostable gates (GATE/M)
 * Gates are exposed as momentary switches that trigger on press
 */
export class GateAccessory {
    private service: Service;
    public device: KseniaGate;
    private autoOffTimeout?: NodeJS.Timeout;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.device = accessory.context.device as KseniaGate;

        const accessoryInfoService = this.accessory.getService(
            this.platform.Service.AccessoryInformation,
        );
        if (accessoryInfoService) {
            accessoryInfoService
                .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ksenia')
                .setCharacteristic(this.platform.Characteristic.Model, 'Lares4 Gate')
                .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
                .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '2.0.0');
        }

        this.service =
            this.accessory.getService(this.platform.Service.Switch) ??
            this.accessory.addService(this.platform.Service.Switch);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

        this.service
            .getCharacteristic(this.platform.Characteristic.On)
            .onSet(this.setOn.bind(this))
            .onGet(this.getOn.bind(this));

        // Initialize as OFF
        this.service.setCharacteristic(this.platform.Characteristic.On, false);
    }

    public async setOn(value: CharacteristicValue): Promise<void> {
        const on = value as boolean;

        if (!on) {
            // User turned OFF manually, just acknowledge
            return;
        }

        try {
            // Clear any existing timeout
            if (this.autoOffTimeout) {
                clearTimeout(this.autoOffTimeout);
            }

            // Send momentary ON command to gate
            await this.platform.wsClient?.toggleGate(this.device.id);
            this.platform.log.info(`${this.device.name}: Gate activated`);

            // Auto-off after 500ms to simulate momentary press
            this.autoOffTimeout = setTimeout(() => {
                this.service.updateCharacteristic(this.platform.Characteristic.On, false);
                this.platform.log.debug(`${this.device.name}: Auto-off triggered`);
            }, 500);

        } catch (error: unknown) {
            this.platform.log.error(
                `Gate control error ${this.device.name}:`,
                error instanceof Error ? error.message : String(error),
            );
            // Reset to OFF on error
            this.service.updateCharacteristic(this.platform.Characteristic.On, false);
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
        }
    }

    public async getOn(): Promise<CharacteristicValue> {
        // Gates are always "off" in terms of state (momentary switch)
        return false;
    }

    public updateDevice(device: KseniaGate): void {
        this.device = device;
        this.accessory.context.device = device;
    }
}
