import type { Logger } from 'homebridge';
import type * as mqtt from 'mqtt';

import { toErrorMessage } from '../errors';
import { logText } from '../mqtt/log-text';
import { parseCommandTopic } from '../mqtt/topic-parser';
import { MAX_COMMAND_PAYLOAD_BYTES, type CommandExecutor } from './command-executor';
import type { ThrottledWarnings } from './throttled-log';

/** QoS 1/2 packet IDs already executed in this connection, to skip broker retransmissions. */
const MAX_TRACKED_PACKET_IDS = 256;

interface CommandIntakeOptions {
    topicPrefix: string;
    log: Logger;
    warnings: ThrottledWarnings;
    executor: CommandExecutor;
}

/** Filters what arrives on the command topics before it reaches the executor. */
export class CommandIntake {
    private readonly executedPacketIds = new Set<number>();

    constructor(private readonly options: CommandIntakeOptions) {}

    /** Packet IDs are scoped to one network connection. */
    public resetConnection(): void {
        this.executedPacketIds.clear();
    }

    public handle(topic: string, payload: Buffer, packet: mqtt.IPublishPacket | undefined): void {
        try {
            this.accept(topic, payload, packet);
        } catch (error: unknown) {
            this.options.log.error('MQTT: Message processing error:', toErrorMessage(error));
        }
    }

    private accept(topic: string, payload: Buffer, packet: mqtt.IPublishPacket | undefined): void {
        const { warnings, log } = this.options;
        // The broker replays retained messages to every new subscription
        // (MQTT-3.3.1-6): executing them would repeat the command at each
        // (re)connect or Homebridge restart.
        if (packet?.retain) {
            warnings.warn(
                'retained',
                `MQTT: Ignoring retained command on ${logText(topic)}. Commands must be published with retain=false; ` +
                    'clear it by publishing an empty retained message to that topic.',
            );
            return;
        }
        // mqtt.js does not deduplicate a QoS 1 retransmission (DUP flag, same packet ID).
        if (packet?.dup && packet.messageId !== undefined && this.executedPacketIds.has(packet.messageId)) {
            log.debug(`MQTT: Ignoring retransmitted command on ${logText(topic)}`);
            return;
        }
        if (packet?.messageId !== undefined && (packet.qos ?? 0) > 0) this.trackPacketId(packet.messageId);

        if (payload.length > MAX_COMMAND_PAYLOAD_BYTES) {
            warnings.warn('payload', `MQTT: Command on ${logText(topic)} ignored: payload larger than ${MAX_COMMAND_PAYLOAD_BYTES} bytes`);
            return;
        }
        const parsedTopic = parseCommandTopic(topic, this.options.topicPrefix);
        if (!parsedTopic) {
            warnings.warn('topic', `MQTT: Invalid topic format: ${logText(topic)}`);
            return;
        }
        const { deviceType, deviceIdentifier, room } = parsedTopic;
        const text = payload.toString();
        log.debug(`MQTT: Command received - Type: ${logText(deviceType)}, Identifier: ${logText(deviceIdentifier)}, Payload: ${logText(text)}`);
        this.options.executor.executeCommand(deviceType, deviceIdentifier, text, room);
    }

    private trackPacketId(messageId: number): void {
        if (this.executedPacketIds.size >= MAX_TRACKED_PACKET_IDS) {
            const oldest = this.executedPacketIds.values().next().value;
            if (oldest !== undefined) this.executedPacketIds.delete(oldest);
        }
        // Re-inserted so a reused ID counts as the newest.
        this.executedPacketIds.delete(messageId);
        this.executedPacketIds.add(messageId);
    }
}
