import type { Logger } from 'homebridge';
import type * as mqtt from 'mqtt';

import type { KseniaDevice } from '../types';
import { createDeviceSlug } from '../mqtt/topic-parser';
import { createDeviceStatePayload } from '../mqtt/state-payload-mapper';
import type { RoomResolver } from './room-resolver';
import { StateTopicRegistry } from './state-topic-registry';

interface StatePublisherOptions {
    topicPrefix: string;
    qos: 0 | 1 | 2;
    retain: boolean;
    log: Logger;
    rooms: RoomResolver;
}

/** Publishes device state on `<prefix>[/<room>]/<type>/<slug>/state`. */
export class StatePublisher {
    /**
     * Latest state per device ID. State topics are retained, so instead of
     * letting mqtt.js queue every publish in memory while offline, only the
     * newest state is kept and republished on each (re)connect.
     */
    private readonly latestDevices = new Map<string, KseniaDevice>();
    /** State topic last published per device ID, to clear it after a rename. */
    private readonly publishedTopics = new Map<string, string>();
    private readonly topics: StateTopicRegistry;

    constructor(private readonly options: StatePublisherOptions) {
        this.topics = new StateTopicRegistry(options.topicPrefix, options.log);
    }

    /** Records the state; publishes it now when a connected client is given. */
    public update(device: KseniaDevice, client: mqtt.MqttClient | undefined): void {
        this.latestDevices.set(device.id, device);
        if (client) this.publish(client, device);
    }

    public publishSnapshot(client: mqtt.MqttClient): void {
        for (const device of this.latestDevices.values()) {
            this.publish(client, device);
        }
    }

    private publish(client: mqtt.MqttClient, device: KseniaDevice): void {
        const room = this.options.rooms.roomFor(device.id);
        const { topic, moved } = this.topics.resolve({
            deviceId: device.id,
            deviceType: device.type,
            room,
            slug: createDeviceSlug(device.name),
        });
        this.send(client, device, topic);
        // A device that now shares this device's name moved to its ID topic: publish it there.
        for (const deviceId of moved) {
            const other = this.latestDevices.get(deviceId);
            if (other) this.publish(client, other);
        }
    }

    private send(client: mqtt.MqttClient, device: KseniaDevice, topic: string): void {
        const { qos, retain } = this.options;
        this.clearStaleStateTopic(client, device.id, topic);
        this.publishedTopics.set(device.id, topic);
        client.publish(topic, JSON.stringify(createDeviceStatePayload(device)), { qos, retain }, (error?: Error): void => {
            if (error) {
                this.publishFailed('MQTT: Publish error:', client, error);
            } else {
                this.options.log.debug(`MQTT: Published state ${topic.slice(this.options.topicPrefix.length + 1)}`);
            }
        });
    }

    /**
     * A publish failed because its connection closed before the broker
     * confirmed it: the state is republished on the next connect, so this is
     * not an error.
     */
    private publishFailed(what: string, client: mqtt.MqttClient, error: Error): void {
        if (client.connected) this.options.log.error(what, error.message);
        else this.options.log.debug(what, error.message, '(connection closed; republished on reconnect)');
    }

    /**
     * State topics are built from the device name (and room), so a rename
     * moves the state to a new topic. The retained message on the old topic
     * is cleared with an empty retained payload, unless another device still
     * publishes there. Only topics published by this process are known.
     */
    private clearStaleStateTopic(client: mqtt.MqttClient, deviceId: string, topic: string): void {
        const previousTopic = this.publishedTopics.get(deviceId);
        if (!this.options.retain || previousTopic === undefined || previousTopic === topic) {
            return;
        }
        for (const [otherId, otherTopic] of this.publishedTopics) {
            if (otherId !== deviceId && otherTopic === previousTopic) {
                return;
            }
        }
        client.publish(previousTopic, '', { qos: this.options.qos, retain: true }, (error?: Error): void => {
            if (error) {
                this.publishFailed('MQTT: Error clearing stale state topic:', client, error);
            } else {
                this.options.log.debug(`MQTT: Cleared stale state topic ${previousTopic}`);
            }
        });
    }
}
