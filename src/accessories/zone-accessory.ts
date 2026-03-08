import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform } from '../platform';
import type { KseniaZone } from '../types';

/**
 * Zone Accessory Handler
 * Handles HomeKit ContactSensor service for Ksenia Lares4 security zones
 */
export class ZoneAccessory {
    private service: Service;
    public device: KseniaZone;
    private lastOpen: boolean;
    private lastActive: boolean;
    private lastFault: boolean;
    private lastBypassed: boolean;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.device = accessory.context.device as KseniaZone;
        this.lastOpen = this.device.status.open;
        this.lastActive = this.isZoneActive(this.device);
        this.lastFault = this.device.status.fault;
        this.lastBypassed = this.device.status.bypassed;

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
        return this.isZoneActive(this.device);
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
            this.isZoneActive(this.device),
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
        this.device = newDevice;
        const newOpen = newDevice.status.open;
        const newActive = this.isZoneActive(newDevice);
        const newFault = newDevice.status.fault;
        const newBypassed = newDevice.status.bypassed;

        this.service.updateCharacteristic(
            this.platform.Characteristic.ContactSensorState,
            newOpen ? 1 : 0,
        );
        if (this.lastOpen !== newOpen) {
            this.platform.log.info(
                `${this.device.name}: ${newOpen ? 'Open' : 'Closed'}`,
            );
        }

        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusActive,
            newActive,
        );
        if (this.lastActive !== newActive) {
            this.platform.log.info(
                `${this.device.name}: ${newActive ? 'Active' : 'Inactive'}`,
            );
        }

        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusFault,
            newFault ? 1 : 0,
        );
        if (this.lastFault !== newFault && newFault) {
            this.platform.log.warn(`${this.device.name}: Fault detected`);
        }

        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusTampered,
            newBypassed ? 1 : 0,
        );
        if (this.lastBypassed !== newBypassed && newBypassed) {
            this.platform.log.warn(`${this.device.name}: Zone bypassed`);
        }

        this.lastOpen = newOpen;
        this.lastActive = newActive;
        this.lastFault = newFault;
        this.lastBypassed = newBypassed;

        this.platform.log.debug(`Updated zone state ${this.device.name}: ${this.getZoneStatusString()}`);
    }

    private isZoneActive(device: KseniaZone): boolean {
        return !device.status.bypassed;
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
