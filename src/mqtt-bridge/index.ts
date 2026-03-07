import * as mqtt from 'mqtt';
import type { Logger } from 'homebridge';

import type { KseniaDevice, MqttConfig } from '../types';
import { buildStateTopic, createDeviceSlug, parseCommandTopic } from '../mqtt/topic-parser';
import { createDeviceStatePayload } from '../mqtt/state-payload-mapper';
import type { Lares4Platform } from '../platform';
import { FatalKlaresError, toErrorMessage } from '../errors';
import { AccessoryIndexService } from './accessory-index-service';
import { CommandExecutor } from './command-executor';

export class MqttBridge {
    private client?: mqtt.MqttClient;
    private readonly topicPrefix: string;
    private readonly accessoryIndex: AccessoryIndexService;
    private readonly commandExecutor: CommandExecutor;

    constructor(
        private readonly config: MqttConfig,
        private readonly log: Logger,
        private readonly platform: Lares4Platform,
    ) {
        this.topicPrefix = config.topicPrefix ?? 'homebridge/klares4';
        this.accessoryIndex = new AccessoryIndexService(this.platform, this.log);
        this.commandExecutor = new CommandExecutor({
            log: this.log,
            findAccessory: (deviceType: string, deviceIdentifier: string) =>
                this.accessoryIndex.findAccessoryByDevice(deviceType, deviceIdentifier),
        });

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
            const connectError = new FatalKlaresError(`MQTT: Connection error: ${toErrorMessage(error)}`);
            this.log.error(connectError.message);
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
            const parsedTopic = parseCommandTopic(topic);
            if (!parsedTopic) {
                this.log.warn('MQTT: Invalid topic format:', topic);
                return;
            }
            const { deviceType, deviceIdentifier } = parsedTopic;

            this.log.debug(
                `MQTT: Command received - Type: ${deviceType}, Identifier: ${deviceIdentifier}, Payload: ${payload}`,
            );

            this.commandExecutor.executeCommand(deviceType, deviceIdentifier, payload);
        } catch (error: unknown) {
            this.log.error('MQTT: Message processing error:', toErrorMessage(error));
        }
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
        const deviceSlug = createDeviceSlug(device.name);
        const topic = buildStateTopic(this.topicPrefix, room, device.type, deviceSlug);
        const payload = createDeviceStatePayload(device);

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

    public disconnect(): void {
        if (this.client) {
            this.client.end();
            this.log.info('MQTT: Disconnected');
        }
    }
}
