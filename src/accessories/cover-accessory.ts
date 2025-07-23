import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform } from '../platform';
import type { KseniaDevice } from '../types';

export class CoverAccessory {
    private service: Service;
    private device: KseniaDevice;
    private targetPosition: number = 0;
    private currentPosition: number = 0;
    private positionState: number = 2; // 2 = stopped
    private maxSeconds: number;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.device = accessory.context.device as KseniaDevice;
        this.currentPosition = this.device.status?.position || 0;
        this.targetPosition = this.device.status?.position || 0;
        this.maxSeconds = (this.platform.config as any).maxSeconds || 30;

        // Imposta le informazioni dell'accessorio
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ksenia')
            .setCharacteristic(this.platform.Characteristic.Model, 'Lares4 Cover')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
            .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '2.0.0');

        // Ottieni o crea il servizio WindowCovering
        this.service = this.accessory.getService(this.platform.Service.WindowCovering)
            || this.accessory.addService(this.platform.Service.WindowCovering);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

        // Imposta gli handlers per le caratteristiche
        this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
            .onGet(this.getCurrentPosition.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.PositionState)
            .onGet(this.getPositionState.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
            .onSet(this.setTargetPosition.bind(this))
            .onGet(this.getTargetPosition.bind(this));

        // Inizializza i valori delle caratteristiche con valori sicuri
        const safeCurrentPosition = isNaN(this.currentPosition) ? 0 : this.currentPosition;
        const safeTargetPosition = isNaN(this.targetPosition) ? 0 : this.targetPosition;

        this.service.setCharacteristic(this.platform.Characteristic.CurrentPosition, safeCurrentPosition);
        this.service.setCharacteristic(this.platform.Characteristic.TargetPosition, safeTargetPosition);
        this.service.setCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
    }

    async setTargetPosition(value: CharacteristicValue): Promise<void> {
        const targetPosition = value as number;

        if (targetPosition === this.currentPosition) {
            return; // Nessun movimento necessario
        }

        this.targetPosition = targetPosition;

        try {
            // Determina lo stato del movimento
            if (targetPosition > this.currentPosition) {
                this.positionState = 1; // Opening
            } else {
                this.positionState = 0; // Closing  
            }

            // Aggiorna lo stato del movimento
            this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);

            await this.platform.wsClient?.moveCover(this.device.id, targetPosition);
            this.platform.log.info(`🪟 ${this.device.name}: Movimento a ${targetPosition}%`);

            // Simula il movimento graduale
            this.simulateMovement(targetPosition);

        } catch (error) {
            this.platform.log.error(`❌ Errore controllo tapparella ${this.device.name}:`, error);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async getTargetPosition(): Promise<CharacteristicValue> {
        return isNaN(this.targetPosition) ? 0 : this.targetPosition;
    }

    async getCurrentPosition(): Promise<CharacteristicValue> {
        return isNaN(this.currentPosition) ? 0 : this.currentPosition;
    }

    async getPositionState(): Promise<CharacteristicValue> {
        return this.positionState;
    }

    private simulateMovement(targetPosition: number): void {
        const startPosition = this.currentPosition;
        const distance = Math.abs(targetPosition - startPosition);
        const direction = targetPosition > startPosition ? 1 : -1;
        const stepSize = (this.platform.config as any).coverStepSize || 5; // % per step (configurabile)
        const totalTime = (distance / 100) * (this.maxSeconds * 1000); // Tempo totale basato su maxSeconds
        const stepTime = totalTime / (distance / stepSize); // Tempo per step calcolato

        let currentStep = 0;
        const totalSteps = Math.ceil(distance / stepSize);

        const moveInterval = setInterval(() => {
            currentStep++;

            if (currentStep >= totalSteps) {
                // Movimento completato
                this.currentPosition = targetPosition;
                this.positionState = 2; // Stopped

                this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, this.currentPosition);
                this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);

                this.platform.log.debug(`🪟 ${this.device.name}: Movimento completato a ${targetPosition}%`);
                clearInterval(moveInterval);
            } else {
                // Movimento in corso
                this.currentPosition = Math.min(100, Math.max(0, startPosition + (direction * stepSize * currentStep)));
                this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, this.currentPosition);
            }
        }, stepTime);
    }

    // Metodo per aggiornare lo stato dall'esterno (aggiornamenti real-time)
    updateStatus(newDevice: KseniaDevice): void {
        this.device = newDevice;

        if (this.device.status?.position !== this.currentPosition) {
            this.currentPosition = this.device.status?.position || 0;
            this.targetPosition = this.device.status?.position || 0;

            // Aggiorna le caratteristiche
            this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, this.currentPosition);
            this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.targetPosition);
        }

        // Aggiorna lo stato del movimento
        switch (this.device.status?.state) {
            case 'opening':
                this.positionState = 1;
                break;
            case 'closing':
                this.positionState = 0;
                break;
            default:
                this.positionState = 2; // stopped
        }

        this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);

        this.platform.log.debug(`🔄 Aggiornato stato tapparella ${this.device.name}: ${this.currentPosition}%`);
    }
} 