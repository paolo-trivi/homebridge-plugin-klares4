import * as mqtt from 'mqtt';
import type { Logger } from 'homebridge';

import type { KseniaDevice, MqttConfig, MqttPanelConnection, MqttStatusPayload } from '../types';
import { buildStatusTopic, isValidTopicPrefix } from '../mqtt/topic-parser';
import { checkBrokerUrl } from '../mqtt/broker-url';
import { DiscoveryService } from '../platform/discovery-service';
import type { Lares4Platform, RuntimeConfig } from '../platform';
import { AccessoryIndexService } from './accessory-index-service';
import { BrokerSession, DEFAULT_RECONNECT_BACKOFF, type MqttConnectFn, type ReconnectBackoff } from './broker-session';
import { CommandExecutor } from './command-executor';
import { CommandIntake } from './command-intake';
import { RoomResolver } from './room-resolver';
import { StatePublisher } from './state-publisher';
import { ThrottledWarnings } from './throttled-log';

export type { MqttConnectFn, ReconnectBackoff } from './broker-session';

/** What the bridge reads from the platform; `Lares4Platform` provides it. */
export type MqttBridgePlatform = Pick<Lares4Platform, 'accessoryHandlers' | 'config'> & {
    readonly runtimeConfig?: RuntimeConfig;
};

export interface MqttBridgeDeps {
    /** Creates the MQTT client; `mqtt.connect` by default. Tests pass a fake. */
    connect?: MqttConnectFn;
    reconnectBackoff?: ReconnectBackoff;
    /** Devices excluded in the config; derived from the platform's validated config by default. */
    isDeviceExcluded?: (device: KseniaDevice) => boolean;
}

const OFFLINE: MqttStatusPayload = { state: 'offline' };

export class MqttBridge {
    private session?: BrokerSession;
    private readonly topicPrefix: string;
    private readonly statusTopic: string;
    private readonly qos: 0 | 1 | 2;
    private readonly commandsEnabled: boolean;
    private readonly publisher: StatePublisher;
    private readonly intake: CommandIntake;
    private panel: MqttPanelConnection = 'unknown';

    constructor(
        private readonly config: MqttConfig,
        private readonly log: Logger,
        platform: MqttBridgePlatform,
        deps: MqttBridgeDeps = {},
    ) {
        this.topicPrefix = config.topicPrefix ?? 'homebridge/klares4';
        this.statusTopic = buildStatusTopic(this.topicPrefix);
        this.qos = config.qos ?? 1;
        this.commandsEnabled = config.commands !== false;
        const warnings = new ThrottledWarnings(log);
        const rooms = new RoomResolver(() => platform.config.roomMapping, log);
        this.publisher = new StatePublisher({ topicPrefix: this.topicPrefix, qos: this.qos, retain: config.retain ?? true, log, rooms });
        const accessoryIndex = new AccessoryIndexService(platform, log, {
            isDeviceExcluded: deps.isDeviceExcluded ?? MqttBridge.exclusionFor(platform, log),
            roomFor: (deviceId: string): string | null => rooms.roomFor(deviceId),
            roomsEnforced: (): boolean => rooms.enabled,
            warnings,
        });
        const executor = new CommandExecutor({
            log,
            warnings,
            findAccessory: (deviceType: string, deviceIdentifier: string, room?: string) =>
                accessoryIndex.findAccessoryByDevice(deviceType, deviceIdentifier, room),
        });
        this.intake = new CommandIntake({ topicPrefix: this.topicPrefix, log, warnings, executor });

        if (config.enabled) {
            this.start(deps);
        }
    }

    private static exclusionFor(platform: MqttBridgePlatform, log: Logger): ((device: KseniaDevice) => boolean) | undefined {
        const runtime = platform.runtimeConfig;
        if (!runtime) return undefined;
        const discovery = new DiscoveryService(platform.config, log, runtime);
        return (device: KseniaDevice): boolean => discovery.isDeviceExcluded(device);
    }

    private start(deps: MqttBridgeDeps): void {
        if (!this.config.broker) {
            this.log.warn('MQTT: Broker not configured');
            return;
        }
        const broker = checkBrokerUrl(this.config.broker);
        if (!broker.ok) {
            this.log.error(`MQTT: Not connecting: ${broker.reason}`);
            return;
        }
        if (!isValidTopicPrefix(this.topicPrefix)) {
            this.log.error('MQTT: Not connecting: topicPrefix must not contain "+" or "#"');
            return;
        }

        this.session = new BrokerSession({
            url: broker.url,
            display: broker.display,
            clientOptions: this.clientOptions(),
            log: this.log,
            connect: deps.connect ?? mqtt.connect,
            backoff: deps.reconnectBackoff ?? DEFAULT_RECONNECT_BACKOFF,
            onConnect: (client: mqtt.MqttClient): void => this.onConnect(client),
            onMessage: (topic: string, payload: Buffer, packet: mqtt.IPublishPacket): void => {
                if (this.commandsEnabled) this.intake.handle(topic, payload, packet);
            },
        });
        this.session.start();
    }

    private clientOptions(): mqtt.IClientOptions {
        // mqtt.js merges explicit options over the ones parsed from the URL, so a
        // default port here would override mqtts://host:8883 or ws:// brokers.
        // Without a port anywhere, mqtt.js picks the protocol default itself.
        const options: mqtt.IClientOptions = {
            ...(this.config.port !== undefined ? { port: this.config.port } : {}),
            clientId:
                this.config.clientId ??
                `homebridge-klares4-${Math.random().toString(16).substring(2, 10)}`,
            // A clean session never replays commands queued while the bridge was away.
            clean: true,
            connectTimeout: 30000,
            will: { topic: this.statusTopic, payload: Buffer.from(JSON.stringify(OFFLINE)), qos: this.qos, retain: true },
        };

        // Username-only auth is valid MQTT; a password without a username is not
        // (MQTT-3.1.2-22), so the password is sent only alongside a username.
        if (this.config.username) {
            options.username = this.config.username;
            if (this.config.password) {
                options.password = this.config.password;
            }
        }
        return options;
    }

    private onConnect(client: mqtt.MqttClient): void {
        this.intake.resetConnection();
        this.publishStatus(client);
        if (this.commandsEnabled) {
            this.subscribeToCommands(client);
        } else {
            this.log.info('MQTT: Commands disabled (mqtt.commands is false): publishing state only');
        }
        this.publisher.publishSnapshot(client);
    }

    private subscribeToCommands(client: mqtt.MqttClient): void {
        const directCommandTopic = `${this.topicPrefix}/+/+/set`;
        const roomCommandTopic = `${this.topicPrefix}/+/+/+/set`;

        client.subscribe([directCommandTopic, roomCommandTopic], { qos: this.qos }, (error: Error | null): void => {
            if (error) {
                this.log.error('MQTT: Subscription error:', error.message);
            } else {
                this.log.info('MQTT: Subscribed to commands:', [directCommandTopic, roomCommandTopic]);
            }
        });
    }

    private publishStatus(client: mqtt.MqttClient): void {
        const status: MqttStatusPayload = { state: 'online', panel: this.panel, timestamp: new Date().toISOString() };
        client.publish(this.statusTopic, JSON.stringify(status), { qos: this.qos, retain: true }, (error?: Error): void => {
            if (error) this.log.error('MQTT: Status publish error:', error.message);
        });
    }

    public publishDeviceState(device: KseniaDevice): void {
        if (!this.session || !this.config.enabled) return;
        this.publisher.update(device, this.session.connectedClient);
    }

    /** The panel connection went up or down; published on `<prefix>/status`. */
    public setPanelConnected(connected: boolean): void {
        const panel: MqttPanelConnection = connected ? 'connected' : 'disconnected';
        if (panel === this.panel) return;
        this.panel = panel;
        const client = this.session?.connectedClient;
        if (client) this.publishStatus(client);
    }

    public disconnect(): void {
        this.session?.stop({ topic: this.statusTopic, payload: JSON.stringify(OFFLINE), qos: this.qos });
    }
}
