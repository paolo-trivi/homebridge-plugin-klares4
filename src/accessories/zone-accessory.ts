import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform } from '../platform';
import type { KseniaZone } from '../types';

export class ZoneAccessory {
    private service: Service;
    private device: KseniaZone;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.device = accessory.context.device as KseniaZone;

        // Imposta le informazioni dell'accessorio
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ksenia')
            .setCharacteristic(this.platform.Characteristic.Model, 'Lares4 Security Zone')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
            .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '2.0.0');

        // Usa ContactSensor per le zone di sicurezza (più appropriato per porte/finestre)
        this.service = this.accessory.getService(this.platform.Service.ContactSensor)
            || this.accessory.addService(this.platform.Service.ContactSensor);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

        // Imposta gli handlers per le caratteristiche
        this.service.getCharacteristic(this.platform.Characteristic.ContactSensorState)
            .onGet(this.getContactState.bind(this));

        // Aggiungi caratteristiche personalizzate per lo stato della zona
        // StatusActive per indicare se la zona è armata
        this.service.getCharacteristic(this.platform.Characteristic.StatusActive)
            .onGet(this.getStatusActive.bind(this));

        // StatusFault per indicare problemi con la zona
        this.service.getCharacteristic(this.platform.Characteristic.StatusFault)
            .onGet(this.getStatusFault.bind(this));

        // StatusTampered per indicare manomissioni (se supportato)
        this.service.getCharacteristic(this.platform.Characteristic.StatusTampered)
            .onGet(this.getStatusTampered.bind(this));

        // Inizializza i valori delle caratteristiche
        this.updateCharacteristics();
    }

    async getContactState(): Promise<CharacteristicValue> {
        // 0 = contact detected (chiuso), 1 = contact not detected (aperto)
        return this.device.status.open ? 1 : 0;
    }

    async getStatusActive(): Promise<CharacteristicValue> {
        // Indica se la zona è armata
        return this.device.status.armed;
    }

    async getStatusFault(): Promise<CharacteristicValue> {
        // 0 = no fault, 1 = general fault
        return this.device.status.fault ? 1 : 0;
    }

    async getStatusTampered(): Promise<CharacteristicValue> {
        // 0 = not tampered, 1 = tampered
        // Usa il campo bypassed come indicatore di possibile manomissione
        return this.device.status.bypassed ? 1 : 0;
    }

    private updateCharacteristics(): void {
        this.service.updateCharacteristic(
            this.platform.Characteristic.ContactSensorState,
            this.device.status.open ? 1 : 0
        );

        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusActive,
            this.device.status.armed
        );

        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusFault,
            this.device.status.fault ? 1 : 0
        );

        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusTampered,
            this.device.status.bypassed ? 1 : 0
        );
    }

    // Metodo per aggiornare lo stato dall'esterno (aggiornamenti real-time)
    updateStatus(newDevice: KseniaZone): void {
        const oldDevice = this.device;
        this.device = newDevice;

        // Aggiorna le caratteristiche solo se necessario
        if (oldDevice.status.open !== newDevice.status.open) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.ContactSensorState,
                newDevice.status.open ? 1 : 0
            );

            this.platform.log.info(`🚪 ${this.device.name}: ${newDevice.status.open ? 'Aperta' : 'Chiusa'}`);
        }

        if (oldDevice.status.armed !== newDevice.status.armed) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.StatusActive,
                newDevice.status.armed
            );

            this.platform.log.info(`🛡️ ${this.device.name}: ${newDevice.status.armed ? 'Armata' : 'Disarmata'}`);
        }

        if (oldDevice.status.fault !== newDevice.status.fault) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.StatusFault,
                newDevice.status.fault ? 1 : 0
            );

            if (newDevice.status.fault) {
                this.platform.log.warn(`⚠️ ${this.device.name}: Fault rilevato`);
            }
        }

        if (oldDevice.status.bypassed !== newDevice.status.bypassed) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.StatusTampered,
                newDevice.status.bypassed ? 1 : 0
            );

            if (newDevice.status.bypassed) {
                this.platform.log.warn(`🔓 ${this.device.name}: Zona bypassata`);
            }
        }

        this.platform.log.debug(`🔄 Aggiornato stato zona ${this.device.name}: ${this.getZoneStatusString()}`);
    }

    private getZoneStatusString(): string {
        const status = [];
        if (this.device.status.open) status.push('Aperta');
        if (this.device.status.armed) status.push('Armata');
        if (this.device.status.fault) status.push('Fault');
        if (this.device.status.bypassed) status.push('Bypassata');

        return status.length > 0 ? status.join(', ') : 'OK';
    }
} 