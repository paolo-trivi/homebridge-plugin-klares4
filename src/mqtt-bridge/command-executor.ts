import type { Logger } from 'homebridge';
import type {
    MqttCoverCommand,
    MqttLightCommand,
    MqttScenarioCommand,
    MqttThermostatCommand,
} from '../types';
import {
    isMqttCoverCommand,
    isMqttLightCommand,
    isMqttScenarioCommand,
    isMqttThermostatCommand,
} from '../types';
import type { AccessoryHandler } from '../platform';
import type { CoverAccessory } from '../accessories/cover-accessory';
import type { LightAccessory } from '../accessories/light-accessory';
import type { ScenarioAccessory } from '../accessories/scenario-accessory';
import type { ThermostatAccessory } from '../accessories/thermostat-accessory';
import { domainModeToHomeKitTarget } from '../thermostat-mode';
import { ValidationKlaresError, toErrorMessage } from '../errors';

interface CommandExecutorDeps {
    log: Logger;
    findAccessory: (deviceType: string, deviceIdentifier: string) => AccessoryHandler | null;
}

export class CommandExecutor {
    constructor(private readonly deps: CommandExecutorDeps) {}

    public executeCommand(deviceType: string, deviceIdentifier: string, payload: string): void {
        try {
            const command: unknown = JSON.parse(payload);

            const accessory = this.deps.findAccessory(deviceType, deviceIdentifier);
            if (!accessory) {
                this.deps.log.warn(
                    `MQTT: Accessory not found - Type: ${deviceType}, Identifier: ${deviceIdentifier}`,
                );
                return;
            }

            switch (deviceType) {
                case 'light':
                    if (isMqttLightCommand(command)) {
                        this.handleLightCommand(accessory as LightAccessory, command);
                    } else {
                        this.deps.log.warn(new ValidationKlaresError('MQTT: Invalid light command payload').message);
                    }
                    break;
                case 'cover':
                    if (isMqttCoverCommand(command)) {
                        this.handleCoverCommand(accessory as CoverAccessory, command);
                    } else {
                        this.deps.log.warn(new ValidationKlaresError('MQTT: Invalid cover command payload').message);
                    }
                    break;
                case 'thermostat':
                    if (isMqttThermostatCommand(command)) {
                        this.handleThermostatCommand(accessory as ThermostatAccessory, command);
                    } else {
                        this.deps.log.warn(
                            new ValidationKlaresError('MQTT: Invalid thermostat command payload').message,
                        );
                    }
                    break;
                case 'scenario':
                    if (isMqttScenarioCommand(command)) {
                        this.handleScenarioCommand(accessory as ScenarioAccessory, command);
                    } else {
                        this.deps.log.warn(
                            new ValidationKlaresError('MQTT: Invalid scenario command payload').message,
                        );
                    }
                    break;
                default:
                    this.deps.log.warn(`MQTT: Unsupported device type for commands: ${deviceType}`);
            }
        } catch (error: unknown) {
            this.deps.log.error('MQTT: Command execution error:', toErrorMessage(error));
        }
    }

    private handleLightCommand(accessory: LightAccessory, command: MqttLightCommand): void {
        if (command.on !== undefined) {
            accessory.setOn(command.on).catch((error: unknown): void => {
                this.deps.log.error('MQTT: Light command error:', toErrorMessage(error));
            });
            this.deps.log.info(`MQTT: Light -> ${command.on ? 'ON' : 'OFF'}`);
        }
        if (command.brightness !== undefined && 'setBrightness' in accessory) {
            accessory.setBrightness(command.brightness).catch((error: unknown): void => {
                this.deps.log.error('MQTT: Brightness command error:', toErrorMessage(error));
            });
            this.deps.log.info(`MQTT: Brightness -> ${command.brightness}%`);
        }
    }

    private handleCoverCommand(accessory: CoverAccessory, command: MqttCoverCommand): void {
        if (command.position !== undefined) {
            accessory.setTargetPosition(command.position).catch((error: unknown): void => {
                this.deps.log.error('MQTT: Cover command error:', toErrorMessage(error));
            });
            this.deps.log.info(`MQTT: Cover -> ${command.position}%`);
        }
    }

    private handleThermostatCommand(accessory: ThermostatAccessory, command: MqttThermostatCommand): void {
        if (command.targetTemperature !== undefined) {
            accessory.setTargetTemperature(command.targetTemperature).catch((error: unknown): void => {
                this.deps.log.error('MQTT: Thermostat temperature error:', toErrorMessage(error));
            });
            this.deps.log.info(`MQTT: Thermostat -> ${command.targetTemperature}C`);
        }
        if (command.mode !== undefined) {
            accessory
                .setTargetHeatingCoolingState(domainModeToHomeKitTarget(command.mode))
                .catch((error: unknown): void => {
                    this.deps.log.error('MQTT: Thermostat mode error:', toErrorMessage(error));
                });
            this.deps.log.info(`MQTT: Thermostat mode -> ${command.mode}`);
        }
    }

    private handleScenarioCommand(accessory: ScenarioAccessory, command: MqttScenarioCommand): void {
        if (command.active !== undefined && command.active) {
            accessory.setOn(true).catch((error: unknown): void => {
                this.deps.log.error('MQTT: Scenario command error:', toErrorMessage(error));
            });
            this.deps.log.info('MQTT: Scenario -> Activated');
        }
    }
}
