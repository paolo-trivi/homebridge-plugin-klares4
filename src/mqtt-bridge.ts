import * as mqtt from 'mqtt';
import type { Logger } from 'homebridge';
import type {
    KseniaDevice,
    KseniaLight,
    KseniaCover,
    KseniaThermostat,
    KseniaSensor,
    KseniaZone,
    KseniaScenario,
    MqttConfig,
    MqttLightCommand,
    MqttCoverCommand,
    MqttThermostatCommand,
    MqttScenarioCommand,
    DeviceStatePayload,
    LightStatePayload,
    CoverStatePayload,
    ThermostatStatePayload,
    SensorStatePayload,
    ZoneStatePayload,
    ScenarioStatePayload,
} from './types';
import {
    isMqttLightCommand,
    isMqttCoverCommand,
    isMqttThermostatCommand,
    isMqttScenarioCommand,
} from './types';
import type { Lares4Platform, AccessoryHandler } from './platform';
import type { LightAccessory } from './accessories/light-accessory';
import type { CoverAccessory } from './accessories/cover-accessory';
import type { ThermostatAccessory } from './accessories/thermostat-accessory';
import type { ScenarioAccessory } from './accessories/scenario-accessory';

/**
 * MQTT Bridge for Ksenia Lares4
 * Publishes device states and receives commands via MQTT
 */
export class MqttBridge {
    private client?: mqtt.MqttClient;
    private readonly config: MqttConfig;
    private readonly log: Logger;
    private readonly platform: Lares4Platform;
    private readonly topicPrefix: string;

    constructor(config: MqttConfig, log: Logger, platform: Lares4Platform) {
        this.config = config;
        this.log = log;
        this.platform = platform;
        this.topicPrefix = config.topicPrefix ?? 'homebridge/klares4';

        if (config.enabled) {
            this.connect();
        }
    }

    private connect(): void {
        if (!this.config.broker) {
            this.log.warn('MQTT: Broker not configured');
            return;
        }

        const options: mqtt.IClientOptions = {
            port: this.config.port ?? 1883,
            clientId:
                this.config.clientId ??
                `homebridge-klares4-${Math.random().toString(16).substring(2, 10)}`,
            clean: true,
            reconnectPeriod: 5000,
            connectTimeout: 30000,
        };

        if (this.config.username && this.config.password) {
            options.username = this.config.username;
            options.password = this.config.password;
        }

        try {
            this.client = mqtt.connect(this.config.broker, options);
            this.setupEventHandlers();
        } catch (error: unknown) {
            this.log.error(
                'MQTT: Connection error:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private setupEventHandlers(): void {
        if (!this.client) return;

        this.client.on('connect', (): void => {
            this.log.info('MQTT: Connected to broker', this.config.broker);
            this.subscribeToCommands();
        });

        this.client.on('error', (error: Error): void => {
            this.log.error('MQTT: Error:', error.message);
        });

        this.client.on('reconnect', (): void => {
            this.log.info('MQTT: Reconnecting...');
        });

        this.client.on('offline', (): void => {
            this.log.warn('MQTT: Disconnected');
        });

        this.client.on('message', (topic: string, payload: Buffer): void => {
            this.handleIncomingMessage(topic, payload.toString());
        });
    }

    private subscribeToCommands(): void {
        if (!this.client) return;

        const directCommandTopic = `${this.topicPrefix}/+/+/set`;
        const roomCommandTopic = `${this.topicPrefix}/+/+/+/set`;

        this.client.subscribe(
            [directCommandTopic, roomCommandTopic],
            { qos: this.config.qos ?? 1 },
            (error: Error | null): void => {
                if (error) {
                    this.log.error('MQTT: Subscription error:', error.message);
                } else {
                    this.log.info('MQTT: Subscribed to commands:', [
                        directCommandTopic,
                        roomCommandTopic,
                    ]);
                }
            },
        );
    }

    private handleIncomingMessage(topic: string, payload: string): void {
        try {
            const topicParts = topic.split('/');
            let deviceType: string;
            let deviceIdentifier: string;

            if (topicParts.length === 5 && topicParts[4] === 'set') {
                deviceType = topicParts[2];
                deviceIdentifier = topicParts[3];
            } else if (topicParts.length === 6 && topicParts[5] === 'set') {
                deviceType = topicParts[3];
                deviceIdentifier = topicParts[4];
            } else {
                this.log.warn('MQTT: Invalid topic format:', topic);
                return;
            }

            this.log.debug(
                `MQTT: Command received - Type: ${deviceType}, Identifier: ${deviceIdentifier}, Payload: ${payload}`,
            );

            this.executeCommand(deviceType, deviceIdentifier, payload);
        } catch (error: unknown) {
            this.log.error(
                'MQTT: Message processing error:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private executeCommand(deviceType: string, deviceIdentifier: string, payload: string): void {
        try {
            const command: unknown = JSON.parse(payload);

            const accessory = this.findAccessoryByDevice(deviceType, deviceIdentifier);
            if (!accessory) {
                this.log.warn(
                    `MQTT: Accessory not found - Type: ${deviceType}, Identifier: ${deviceIdentifier}`,
                );
                return;
            }

            switch (deviceType) {
                case 'light':
                    if (isMqttLightCommand(command)) {
                        this.handleLightCommand(accessory as LightAccessory, command);
                    }
                    break;
                case 'cover':
                    if (isMqttCoverCommand(command)) {
                        this.handleCoverCommand(accessory as CoverAccessory, command);
                    }
                    break;
                case 'thermostat':
                    if (isMqttThermostatCommand(command)) {
                        this.handleThermostatCommand(accessory as ThermostatAccessory, command);
                    }
                    break;
                case 'scenario':
                    if (isMqttScenarioCommand(command)) {
                        this.handleScenarioCommand(accessory as ScenarioAccessory, command);
                    }
                    break;
                default:
                    this.log.warn(`MQTT: Unsupported device type for commands: ${deviceType}`);
            }
        } catch (error: unknown) {
            this.log.error(
                'MQTT: Command execution error:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private findAccessoryByDevice(
        deviceType: string,
        deviceIdentifier: string,
    ): AccessoryHandler | null {
        for (const [, handler] of this.platform.accessoryHandlers) {
            const device = this.getDeviceFromHandler(handler);
            if (device && device.type === deviceType) {
                const deviceSlug = this.createDeviceSlug(device.name);
                if (device.id === deviceIdentifier || deviceSlug === deviceIdentifier) {
                    return handler;
                }
            }
        }
        return null;
    }

    private getDeviceFromHandler(handler: AccessoryHandler): KseniaDevice | undefined {
        if ('device' in handler && handler.device) {
            return handler.device as KseniaDevice;
        }
        return undefined;
    }

    private handleLightCommand(accessory: LightAccessory, command: MqttLightCommand): void {
        if (command.on !== undefined) {
            accessory.setOn(command.on).catch((error: unknown): void => {
                this.log.error(
                    'MQTT: Light command error:',
                    error instanceof Error ? error.message : String(error),
                );
            });
            this.log.info(`MQTT: Light -> ${command.on ? 'ON' : 'OFF'}`);
        }
        if (command.brightness !== undefined && 'setBrightness' in accessory) {
            accessory.setBrightness(command.brightness).catch((error: unknown): void => {
                this.log.error(
                    'MQTT: Brightness command error:',
                    error instanceof Error ? error.message : String(error),
                );
            });
            this.log.info(`MQTT: Brightness -> ${command.brightness}%`);
        }
    }

    private handleCoverCommand(accessory: CoverAccessory, command: MqttCoverCommand): void {
        if (command.position !== undefined) {
            accessory.setTargetPosition(command.position).catch((error: unknown): void => {
                this.log.error(
                    'MQTT: Cover command error:',
                    error instanceof Error ? error.message : String(error),
                );
            });
            this.log.info(`MQTT: Cover -> ${command.position}%`);
        }
    }

    private handleThermostatCommand(
        accessory: ThermostatAccessory,
        command: MqttThermostatCommand,
    ): void {
        if (command.targetTemperature !== undefined) {
            accessory.setTargetTemperature(command.targetTemperature).catch((error: unknown): void => {
                this.log.error(
                    'MQTT: Thermostat temperature error:',
                    error instanceof Error ? error.message : String(error),
                );
            });
            this.log.info(`MQTT: Thermostat -> ${command.targetTemperature}C`);
        }
        if (command.mode !== undefined) {
            accessory
                .setTargetHeatingCoolingState(this.getModeValue(command.mode))
                .catch((error: unknown): void => {
                    this.log.error(
                        'MQTT: Thermostat mode error:',
                        error instanceof Error ? error.message : String(error),
                    );
                });
            this.log.info(`MQTT: Thermostat mode -> ${command.mode}`);
        }
    }

    private handleScenarioCommand(accessory: ScenarioAccessory, command: MqttScenarioCommand): void {
        if (command.active !== undefined && command.active) {
            accessory.setOn(true).catch((error: unknown): void => {
                this.log.error(
                    'MQTT: Scenario command error:',
                    error instanceof Error ? error.message : String(error),
                );
            });
            this.log.info('MQTT: Scenario -> Activated');
        }
    }

    private getModeValue(mode: string): number {
        switch (mode) {
            case 'off':
                return 0;
            case 'heat':
                return 1;
            case 'cool':
                return 2;
            case 'auto':
                return 3;
            default:
                return 0;
        }
    }

    private createDeviceSlug(deviceName: string): string {
        return deviceName
            .toLowerCase()
            .replace(/\s+/g, '_')
            .replace(/[àáâãäå]/g, 'a')
            .replace(/[èéêë]/g, 'e')
            .replace(/[ìíîï]/g, 'i')
            .replace(/[òóôõö]/g, 'o')
            .replace(/[ùúûü]/g, 'u')
            .replace(/[ç]/g, 'c')
            .replace(/[^a-z0-9_]/g, '')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '');
    }

    private getRoomForDevice(deviceId: string): string | null {
        if (!this.platform.config.roomMapping?.enabled) {
            return null;
        }

        if (this.platform.config.roomMapping.rooms) {
            for (const room of this.platform.config.roomMapping.rooms) {
                if (room.devices) {
                    for (const device of room.devices) {
                        if (device.deviceId === deviceId) {
                            return room.roomName;
                        }
                    }
                }
            }
        }

        return null;
    }

    public publishDeviceState(device: KseniaDevice): void {
        if (!this.client || !this.config.enabled) return;

        const room = this.getRoomForDevice(device.id);
        const deviceSlug = this.createDeviceSlug(device.name);

        let topic: string;
        if (room) {
            topic = `${this.topicPrefix}/${room}/${device.type}/${deviceSlug}/state`;
        } else {
            topic = `${this.topicPrefix}/${device.type}/${deviceSlug}/state`;
        }

        const payload = this.createStatePayload(device);

        this.client.publish(
            topic,
            JSON.stringify(payload),
            {
                qos: this.config.qos ?? 1,
                retain: this.config.retain ?? true,
            },
            (error: Error | undefined): void => {
                if (error) {
                    this.log.error('MQTT: Publish error:', error.message);
                } else {
                    const topicPath = room
                        ? `${room}/${device.type}/${deviceSlug}`
                        : `${device.type}/${deviceSlug}`;
                    this.log.debug(`MQTT: Published state ${topicPath}`);
                }
            },
        );
    }

    private createStatePayload(device: KseniaDevice): DeviceStatePayload {
        const basePayload = {
            id: device.id,
            name: device.name,
            type: device.type,
            timestamp: new Date().toISOString(),
        };

        switch (device.type) {
            case 'light': {
                const light = device as KseniaLight;
                const lightPayload: LightStatePayload = {
                    ...basePayload,
                    on: light.status?.on ?? false,
                    brightness: light.status?.brightness ?? 0,
                    dimmable: light.status?.dimmable ?? false,
                };
                return lightPayload;
            }

            case 'cover': {
                const cover = device as KseniaCover;
                const coverPayload: CoverStatePayload = {
                    ...basePayload,
                    position: cover.status?.position ?? 0,
                    state: cover.status?.state ?? 'stopped',
                };
                return coverPayload;
            }

            case 'thermostat': {
                const thermostat = device as KseniaThermostat;
                const thermostatPayload: ThermostatStatePayload = {
                    ...basePayload,
                    currentTemperature: thermostat.currentTemperature ?? 0,
                    targetTemperature: thermostat.targetTemperature ?? 20,
                    mode: thermostat.mode ?? 'off',
                    humidity: thermostat.humidity,
                };
                return thermostatPayload;
            }

            case 'sensor': {
                const sensor = device as KseniaSensor;
                const sensorPayload: SensorStatePayload = {
                    ...basePayload,
                    sensorType: sensor.status?.sensorType ?? 'unknown',
                    value: sensor.status?.value ?? 0,
                    unit: sensor.status?.unit ?? '',
                };
                return sensorPayload;
            }

            case 'zone': {
                const zone = device as KseniaZone;
                const zonePayload: ZoneStatePayload = {
                    ...basePayload,
                    open: zone.status?.open ?? false,
                    armed: zone.status?.armed ?? false,
                    fault: zone.status?.fault ?? false,
                    bypassed: zone.status?.bypassed ?? false,
                };
                return zonePayload;
            }

            case 'scenario': {
                const scenario = device as KseniaScenario;
                const scenarioPayload: ScenarioStatePayload = {
                    ...basePayload,
                    active: scenario.status?.active ?? false,
                };
                return scenarioPayload;
            }

            default: {
                const unknownPayload: ScenarioStatePayload = {
                    ...basePayload,
                    active: false,
                };
                return unknownPayload;
            }
        }
    }

    public disconnect(): void {
        if (this.client) {
            this.client.end();
            this.log.info('MQTT: Disconnected');
        }
    }
}
