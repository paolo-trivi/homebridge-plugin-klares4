import type { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import type { Lares4Platform, Lares4Config } from '../platform';
import type { KseniaScenario } from '../types';

/**
 * Scenario Accessory Handler
 * Handles HomeKit Switch service for Ksenia Lares4 scenarios
 */
export class ScenarioAccessory {
    private service: Service;
    public readonly device: KseniaScenario;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
        device: KseniaScenario,
    ) {
        this.device = device;

        const accessoryInfoService = this.accessory.getService(
            this.platform.Service.AccessoryInformation,
        );
        if (accessoryInfoService) {
            accessoryInfoService
                .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ksenia')
                .setCharacteristic(this.platform.Characteristic.Model, 'Lares4 Scenario')
                .setCharacteristic(this.platform.Characteristic.SerialNumber, device.id);
        }

        this.service =
            this.accessory.getService(this.platform.Service.Switch) ??
            this.accessory.addService(this.platform.Service.Switch);

        this.service.setCharacteristic(this.platform.Characteristic.Name, device.name);

        this.service
            .getCharacteristic(this.platform.Characteristic.On)
            .onSet(this.setOn.bind(this))
            .onGet(this.getOn.bind(this));
    }

    public async setOn(value: CharacteristicValue): Promise<void> {
        const isOn = value as boolean;

        if (isOn) {
            try {
                if (!this.platform.wsClient) {
                    throw new Error('WebSocket client not initialized');
                }
                await this.platform.wsClient.triggerScenario(this.device.id);
                this.platform.log.info(`Scenario ${this.device.name} executed`);

                const autoOffDelay =
                    (this.platform.config as Lares4Config).scenarioAutoOffDelay ?? 500;
                setTimeout((): void => {
                    if (this.service) {
                        this.service.updateCharacteristic(this.platform.Characteristic.On, false);
                        this.platform.log.debug(
                            `Scenario ${this.device.name} automatically turned off after ${autoOffDelay}ms`,
                        );
                    }
                }, autoOffDelay);
            } catch (error: unknown) {
                this.platform.log.error(
                    `Scenario execution error ${this.device.name}:`,
                    error instanceof Error ? error.message : String(error),
                );
                throw new this.platform.api.hap.HapStatusError(
                    this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
                );
            }
        }
        // Do nothing for "off" - scenarios are momentary
    }

    public async getOn(): Promise<CharacteristicValue> {
        // Scenarios don't have persistent state, always return false
        return false;
    }
}