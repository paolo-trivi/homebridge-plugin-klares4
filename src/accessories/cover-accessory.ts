import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform, Lares4Config } from '../platform';
import type { KseniaCover, CoverStatus } from '../types';

/**
 * Cover Accessory Handler
 * Handles HomeKit WindowCovering service for Ksenia Lares4 covers/shutters
 */
export class CoverAccessory {
    private service: Service;
    public device: KseniaCover;
    private targetPosition: number = 0;
    private currentPosition: number = 0;
    private positionState: number = 2; // 2 = stopped
    private readonly maxSeconds: number;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.device = accessory.context.device as KseniaCover;
        this.currentPosition = this.device.status?.position ?? 0;
        this.targetPosition = this.device.status?.position ?? 0;
        this.maxSeconds = (this.platform.config as Lares4Config).maxSeconds ?? 30;

        const accessoryInfoService = this.accessory.getService(
            this.platform.Service.AccessoryInformation,
        );
        if (accessoryInfoService) {
            accessoryInfoService
                .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ksenia')
                .setCharacteristic(this.platform.Characteristic.Model, 'Lares4 Cover')
                .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
                .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '2.0.0');
        }

        this.service =
            this.accessory.getService(this.platform.Service.WindowCovering) ??
            this.accessory.addService(this.platform.Service.WindowCovering);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

        this.service
            .getCharacteristic(this.platform.Characteristic.CurrentPosition)
            .onGet(this.getCurrentPosition.bind(this));

        this.service
            .getCharacteristic(this.platform.Characteristic.PositionState)
            .onGet(this.getPositionState.bind(this));

        this.service
            .getCharacteristic(this.platform.Characteristic.TargetPosition)
            .onSet(this.setTargetPosition.bind(this))
            .onGet(this.getTargetPosition.bind(this));

        const safeCurrentPosition = isNaN(this.currentPosition) ? 0 : this.currentPosition;
        const safeTargetPosition = isNaN(this.targetPosition) ? 0 : this.targetPosition;

        this.service.setCharacteristic(
            this.platform.Characteristic.CurrentPosition,
            safeCurrentPosition,
        );
        this.service.setCharacteristic(
            this.platform.Characteristic.TargetPosition,
            safeTargetPosition,
        );
        this.service.setCharacteristic(
            this.platform.Characteristic.PositionState,
            this.positionState,
        );
    }

    public async setTargetPosition(value: CharacteristicValue): Promise<void> {
        const targetPosition = value as number;

        if (targetPosition === this.currentPosition) {
            return;
        }

        this.targetPosition = targetPosition;

        try {
            if (targetPosition > this.currentPosition) {
                this.positionState = 1; // Opening
            } else {
                this.positionState = 0; // Closing
            }

            this.service.updateCharacteristic(
                this.platform.Characteristic.PositionState,
                this.positionState,
            );

            await this.platform.wsClient?.moveCover(this.device.id, targetPosition);
            this.platform.log.info(`${this.device.name}: Moving to ${targetPosition}%`);

            this.simulateMovement(targetPosition);
        } catch (error: unknown) {
            this.platform.log.error(
                `Cover control error ${this.device.name}:`,
                error instanceof Error ? error.message : String(error),
            );
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
        }
    }

    public async getTargetPosition(): Promise<CharacteristicValue> {
        return isNaN(this.targetPosition) ? 0 : this.targetPosition;
    }

    public async getCurrentPosition(): Promise<CharacteristicValue> {
        return isNaN(this.currentPosition) ? 0 : this.currentPosition;
    }

    public async getPositionState(): Promise<CharacteristicValue> {
        return this.positionState;
    }

    private simulateMovement(targetPosition: number): void {
        const startPosition = this.currentPosition;
        const distance = Math.abs(targetPosition - startPosition);
        const direction = targetPosition > startPosition ? 1 : -1;
        const stepSize = (this.platform.config as Lares4Config).coverStepSize ?? 5;
        const totalTime = (distance / 100) * (this.maxSeconds * 1000);
        const stepTime = totalTime / (distance / stepSize);

        let currentStep = 0;
        const totalSteps = Math.ceil(distance / stepSize);

        const moveInterval = setInterval((): void => {
            currentStep++;

            if (currentStep >= totalSteps) {
                this.currentPosition = targetPosition;
                this.positionState = 2; // Stopped

                this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentPosition,
                    this.currentPosition,
                );
                this.service.updateCharacteristic(
                    this.platform.Characteristic.PositionState,
                    this.positionState,
                );

                this.platform.log.debug(
                    `${this.device.name}: Movement completed to ${targetPosition}%`,
                );
                clearInterval(moveInterval);
            } else {
                this.currentPosition = Math.min(
                    100,
                    Math.max(0, startPosition + direction * stepSize * currentStep),
                );
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentPosition,
                    this.currentPosition,
                );
            }
        }, stepTime);
    }

    public updateStatus(newDevice: KseniaCover): void {
        this.device = newDevice;

        if (this.device.status?.position !== this.currentPosition) {
            this.currentPosition = this.device.status?.position ?? 0;
            this.targetPosition = this.device.status?.position ?? 0;

            this.service.updateCharacteristic(
                this.platform.Characteristic.CurrentPosition,
                this.currentPosition,
            );
            this.service.updateCharacteristic(
                this.platform.Characteristic.TargetPosition,
                this.targetPosition,
            );
        }

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

        this.service.updateCharacteristic(
            this.platform.Characteristic.PositionState,
            this.positionState,
        );

        this.platform.log.debug(`Updated cover state ${this.device.name}: ${this.currentPosition}%`);
    }
}