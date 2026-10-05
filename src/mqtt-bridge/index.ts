import * as mqtt from 'mqtt';
import type { Logger } from 'homebridge';

import type { KseniaDevice, MqttConfig } from '../types';
import { buildStateTopic, createDeviceSlug, parseCommandTopic, sanitizeTopicLevel } from '../mqtt/topic-parser';
import { createDeviceStatePayload } from '../mqtt/state-payload-mapper';
import { maskBrokerUrl } from '../mqtt/broker-url';
import type { Lares4Platform } from '../platform';
import { FatalKlaresError, toErrorMessage } from '../errors';
import { AccessoryIndexService } from './accessory-index-service';
import { CommandExecutor } from './command-executor';

export class MqttBridge {
    private client?: mqtt.MqttClient;
    private readonly topicPrefix: string;
    private readonly accessoryIndex: AccessoryIndexService;
    private readonly commandExecutor: CommandExecutor;
    /** Room names already reported as unsafe for a topic level (warn once each). */
    private readonly warnedRoomNames = new Set<string>();
    /**
     * Latest state per device ID. State topics are retained, so instead of
     * letting mqtt.js queue every publish in memory while offline, only the
     * newest state is kept and republished on each (re)connect.
     */
    private readonly latestDevices = new Map<string, KseniaDevice>();
    /** State topic last published per device ID, to clear it after a rename. */
    private readonly publishedTopics = new Map<string, string>();

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

        // mqtt.js merges explicit options over the ones parsed from the URL, so a
        // default port here would override mqtts://host:8883 or ws:// brokers.
        // Without a port anywhere, mqtt.js picks the protocol default itself.
        const options: mqtt.IClientOptions = {
            ...(this.config.port !== undefined ? { port: this.config.port } : {}),
            clientId:
                this.config.clientId ??
                `homebridge-klares4-${Math.random().toString(16).substring(2, 10)}`,
            clean: true,
            reconnectPeriod: 5000,
            connectTimeout: 30000,
        };

        // Username-only auth is valid MQTT; a password without a username is not
        // (MQTT-3.1.2-22), so the password is sent only alongside a username.
        if (this.config.username) {
            options.username = this.config.username;
            if (this.config.password) {
                options.password = this.config.password;
            }
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
            this.log.info('MQTT: Connected to broker', maskBrokerUrl(this.config.broker));
            this.subscribeToCommands();
            this.publishStateSnapshot();
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

        this.client.on('message', (topic: string, payload: Buffer, packet?: mqtt.IPublishPacket): void => {
            // The broker replays retained messages to every new subscription
            // (MQTT-3.3.1-6): executing them would repeat the command at each
            // (re)connect or Homebridge restart.
            if (packet?.retain) {
                this.log.warn(
                    `MQTT: Ignoring retained command on ${topic}. Commands must be published with retain=false; ` +
                        'clear it by publishing an empty retained message to that topic.',
                );
                return;
            }
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
            const parsedTopic = parseCommandTopic(topic, this.topicPrefix);
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
                            return this.toTopicRoom(room.roomName);
                        }
                    }
                }
            }
        }

        return null;
    }

    private toTopicRoom(roomName: string): string {
        const safeRoom = sanitizeTopicLevel(roomName);
        if (safeRoom !== roomName && !this.warnedRoomNames.has(roomName)) {
            this.warnedRoomNames.add(roomName);
            this.log.warn(
                `MQTT: Room name "${roomName}" contains '+', '#' or '/', which are not allowed in a topic level; ` +
                    `publishing under "${safeRoom}" instead.`,
            );
        }
        return safeRoom;
    }

    public publishDeviceState(device: KseniaDevice): void {
        if (!this.client || !this.config.enabled) return;

        this.latestDevices.set(device.id, device);
        if (!this.client.connected) {
            return; // republished from latestDevices on the next 'connect'
        }
        this.publishState(this.client, device);
    }

    private publishStateSnapshot(): void {
        const client = this.client;
        if (!client) return;
        for (const device of this.latestDevices.values()) {
            this.publishState(client, device);
        }
    }

    private publishState(client: mqtt.MqttClient, device: KseniaDevice): void {
        const room = this.getRoomForDevice(device.id);
        const deviceSlug = createDeviceSlug(device.name);
        const topic = buildStateTopic(this.topicPrefix, room, device.type, deviceSlug);
        const payload = createDeviceStatePayload(device);
        const retain = this.config.retain ?? true;

        this.clearStaleStateTopic(client, device.id, topic, retain);
        this.publishedTopics.set(device.id, topic);

        client.publish(
            topic,
            JSON.stringify(payload),
            {
                qos: this.config.qos ?? 1,
                retain,
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

    /**
     * State topics are built from the device name (and room), so a rename
     * moves the state to a new topic. The retained message on the old topic
     * is cleared with an empty retained payload, unless another device still
     * publishes there. Only topics published by this process are known.
     */
    private clearStaleStateTopic(client: mqtt.MqttClient, deviceId: string, topic: string, retain: boolean): void {
        const previousTopic = this.publishedTopics.get(deviceId);
        if (!retain || previousTopic === undefined || previousTopic === topic) {
            return;
        }
        for (const [otherId, otherTopic] of this.publishedTopics) {
            if (otherId !== deviceId && otherTopic === previousTopic) {
                return;
            }
        }
        client.publish(previousTopic, '', { qos: this.config.qos ?? 1, retain: true }, (error?: Error): void => {
            if (error) {
                this.log.error('MQTT: Error clearing stale state topic:', error.message);
            } else {
                this.log.debug(`MQTT: Cleared stale state topic ${previousTopic}`);
            }
        });
    }

    public disconnect(): void {
        if (this.client) {
            this.client.end();
            this.log.info('MQTT: Disconnected');
        }
    }
}
