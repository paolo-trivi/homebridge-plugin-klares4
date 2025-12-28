import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform } from '../platform';
import type { KseniaZone, ZoneStatus } from '../types';

/**
 * Zone Accessory Handler
 * Handles HomeKit ContactSensor service for Ksenia Lares4 security zones
 */
export class ZoneAccessory {
    private service: Service;
    public device: KseniaZone;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.device = accessory.context.device as KseniaZone;

        const accessoryInfoService = this.accessory.getService(
            this.platform.Service.AccessoryInformation,
        );
        if (accessoryInfoService) {
            accessoryInfoService
                .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ksenia')
                .setCharacteristic(this.platform.Characteristic.Model, 'Lares4 Security Zone')
                .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
                .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '2.0.0');
        }

        this.service =
            this.accessory.getService(this.platform.Service.ContactSensor) ??
            this.accessory.addService(this.platform.Service.ContactSensor);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

        this.service
            .getCharacteristic(this.platform.Characteristic.ContactSensorState)
            .onGet(this.getContactState.bind(this));

        this.service
            .getCharacteristic(this.platform.Characteristic.StatusActive)
            .onGet(this.getStatusActive.bind(this));

        this.service
            .getCharacteristic(this.platform.Characteristic.StatusFault)
            .onGet(this.getStatusFault.bind(this));

        this.service
            .getCharacteristic(this.platform.Characteristic.StatusTampered)
            .onGet(this.getStatusTampered.bind(this));

        this.updateCharacteristics();
    }

    public async getContactState(): Promise<CharacteristicValue> {
        // 0 = contact detected (closed), 1 = contact not detected (open)
        return this.device.status.open ? 1 : 0;
    }

    public async getStatusActive(): Promise<CharacteristicValue> {
        return this.device.status.armed;
    }

    public async getStatusFault(): Promise<CharacteristicValue> {
        // 0 = no fault, 1 = general fault
        return this.device.status.fault ? 1 : 0;
    }

    public async getStatusTampered(): Promise<CharacteristicValue> {
        // 0 = not tampered, 1 = tampered
        return this.device.status.bypassed ? 1 : 0;
    }

    private updateCharacteristics(): void {
        this.service.updateCharacteristic(
            this.platform.Characteristic.ContactSensorState,
            this.device.status.open ? 1 : 0,
        );

        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusActive,
            this.device.status.armed,
        );

        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusFault,
            this.device.status.fault ? 1 : 0,
        );

        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusTampered,
            this.device.status.bypassed ? 1 : 0,
        );
    }

    public updateStatus(newDevice: KseniaZone): void {
        const oldDevice = this.device;
        this.device = newDevice;

        if (oldDevice.status.open !== newDevice.status.open) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.ContactSensorState,
                newDevice.status.open ? 1 : 0,
            );

            this.platform.log.info(
                `${this.device.name}: ${newDevice.status.open ? 'Open' : 'Closed'}`,
            );
        }

        if (oldDevice.status.armed !== newDevice.status.armed) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.StatusActive,
                newDevice.status.armed,
            );

            this.platform.log.info(
                `${this.device.name}: ${newDevice.status.armed ? 'Armed' : 'Disarmed'}`,
            );
        }

        if (oldDevice.status.fault !== newDevice.status.fault) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.StatusFault,
                newDevice.status.fault ? 1 : 0,
            );

            if (newDevice.status.fault) {
                this.platform.log.warn(`${this.device.name}: Fault detected`);
            }
        }

        if (oldDevice.status.bypassed !== newDevice.status.bypassed) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.StatusTampered,
                newDevice.status.bypassed ? 1 : 0,
            );

            if (newDevice.status.bypassed) {
                this.platform.log.warn(`${this.device.name}: Zone bypassed`);
            }
        }

        this.platform.log.debug(`Updated zone state ${this.device.name}: ${this.getZoneStatusString()}`);
    }

    private getZoneStatusString(): string {
        const status: string[] = [];
        if (this.device.status.open) status.push('Open');
        if (this.device.status.armed) status.push('Armed');
        if (this.device.status.fault) status.push('Fault');
        if (this.device.status.bypassed) status.push('Bypassed');

        return status.length > 0 ? status.join(', ') : 'OK';
    }
}