import type { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import type { Lares4Platform } from '../platform';
import type { KseniaScenario } from '../types';
import { PLUGIN_VERSION } from '../plugin-version';
import { sanitizeHapDisplayName } from '../display-name';
import { communicationFailure } from './communication-failure';
import { toErrorMessage } from '../errors';

/**
 * Scenario Accessory Handler
 * Handles HomeKit Switch service for Ksenia Lares4 scenarios
 */
export class ScenarioAccessory {
    private service: Service;
    public device: KseniaScenario;
    private autoOffTimeout?: NodeJS.Timeout;

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
                .setCharacteristic(
                    this.platform.Characteristic.SerialNumber,
                    device.id || `lares4-${accessory.UUID.slice(0, 8)}`,
                )
                .setCharacteristic(this.platform.Characteristic.FirmwareRevision, PLUGIN_VERSION);
        }

        this.service =
            this.accessory.getService(this.platform.Service.Switch) ??
            this.accessory.addService(this.platform.Service.Switch);

        this.service.setCharacteristic(this.platform.Characteristic.Name, sanitizeHapDisplayName(device.name, device.id));

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

                const autoOffDelay = this.platform.config.scenarioAutoOffDelay ?? 500;
                if (this.autoOffTimeout) {
                    clearTimeout(this.autoOffTimeout);
                }
                this.autoOffTimeout = setTimeout((): void => {
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
                    toErrorMessage(error),
                );
                throw communicationFailure(this.platform.api, error);
            }
        }
        // Do nothing for "off" - scenarios are momentary
    }

    public async getOn(): Promise<CharacteristicValue> {
        // Scenarios don't have persistent state, always return false
        return false;
    }

    /** The panel renamed or reconfigured the scenario: the handler (and the cached context) follow. */
    public updateDevice(device: KseniaScenario): void {
        this.device = device;
        this.accessory.context.device = device;
    }

    public dispose(): void {
        if (this.autoOffTimeout) {
            clearTimeout(this.autoOffTimeout);
            this.autoOffTimeout = undefined;
        }
    }
}
