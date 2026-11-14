import type { Logger } from 'homebridge';
import type * as mqtt from 'mqtt';

import { toErrorMessage } from '../errors';

export type MqttConnectFn = (brokerUrl: string, options: mqtt.IClientOptions) => mqtt.MqttClient;

export interface ReconnectBackoff {
    initialMs: number;
    maxMs: number;
}

export const DEFAULT_RECONNECT_BACKOFF: ReconnectBackoff = { initialMs: 5000, maxMs: 60000 };

interface BrokerSessionOptions {
    url: string;
    /** `scheme://host[:port]`, never with credentials. */
    display: string;
    clientOptions: mqtt.IClientOptions;
    log: Logger;
    connect: MqttConnectFn;
    backoff: ReconnectBackoff;
    onConnect: (client: mqtt.MqttClient) => void;
    onMessage: (topic: string, payload: Buffer, packet: mqtt.IPublishPacket) => void;
}

/** CONNACK "Not authorized" (MQTT 3.1.1 return code 5, MQTT 5 reason code 135). */
function isNotAuthorized(error: Error): boolean {
    const code: unknown = 'code' in error ? error.code : undefined;
    return code === 5 || code === 135;
}

/**
 * One broker connection, kept alive by the plugin rather than by mqtt.js.
 * With `reconnectPeriod > 0` mqtt.js 5.16 retries at a fixed interval
 * (`client.js` `_setupReconnect`, a `setInterval`) and stops for good after a
 * refused CONNACK unless `reconnectOnConnackError` is set
 * (`handlers/connack.js:42-55`). Here mqtt.js never reconnects by itself
 * (`reconnectPeriod: 0`) and every `close` schedules `client.reconnect()`
 * with a delay that doubles up to `maxMs`; `connect()` clears
 * `reconnectSuppressed` (`client.js:312-313`), so a refused CONNACK is
 * retried like any other failure. Log lines are written on transitions only.
 */
export class BrokerSession {
    private client?: mqtt.MqttClient;
    private stopped = false;
    private timer?: NodeJS.Timeout;
    private delayMs: number;
    private connectedOnce = false;
    private wasConnected = false;
    private failing = false;
    private lastError?: string;
    /** The last will is dropped after the broker refused a CONNECT carrying it (see `onError`). */
    private willRefused = false;
    private willProbe = false;

    constructor(private readonly options: BrokerSessionOptions) {
        this.delayMs = options.backoff.initialMs;
    }

    public get connectedClient(): mqtt.MqttClient | undefined {
        return this.client?.connected ? this.client : undefined;
    }

    public start(): void {
        try {
            const client = this.options.connect(this.options.url, this.clientOptions());
            this.client = client;
            client.on('connect', () => this.onConnect(client));
            client.on('error', (error: Error) => this.onError(error));
            client.on('close', () => this.onClose(client));
            client.on('message', (topic: string, payload: Buffer, packet: mqtt.IPublishPacket) =>
                this.options.onMessage(topic, payload, packet));
        } catch (error: unknown) {
            this.options.log.error(`MQTT: Connection error: ${toErrorMessage(error)}`);
        }
    }

    /** Publishes `last` (if connected) and closes the connection; no reconnect afterwards. */
    public stop(last?: { topic: string; payload: string; qos: 0 | 1 | 2 }): void {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        const client = this.client;
        if (!client) return;
        if (client.connected && last) {
            client.publish(last.topic, last.payload, { qos: last.qos, retain: true });
        }
        client.end(!client.connected, {}, () => this.options.log.info('MQTT: Disconnected'));
    }

    private clientOptions(): mqtt.IClientOptions {
        const { will, ...rest } = this.options.clientOptions;
        return { ...rest, ...(will && !this.willRefused ? { will } : {}), reconnectPeriod: 0 };
    }

    private onConnect(client: mqtt.MqttClient): void {
        const verb = this.failing ? 'Reconnected' : 'Connected';
        this.options.log.info(`MQTT: ${verb} to broker ${this.options.display}`);
        if (this.willProbe) {
            this.options.log.warn(
                'MQTT: The broker refused the connection while it carried the last will on the status topic, ' +
                    'and accepted it without: availability is published, but a crash will not mark the bridge offline. ' +
                    'Allow this user to write the status topic in the broker ACL and restart Homebridge.',
            );
            this.willProbe = false;
        }
        this.delayMs = this.options.backoff.initialMs;
        this.connectedOnce = true;
        this.wasConnected = true;
        this.failing = false;
        this.lastError = undefined;
        this.options.onConnect(client);
    }

    private onError(error: Error): void {
        const message = toErrorMessage(error);
        if (isNotAuthorized(error) && this.options.clientOptions.will) {
            this.adaptWill();
        }
        if (message === this.lastError) {
            this.options.log.debug(`MQTT: Error: ${message}`);
            return;
        }
        this.lastError = message;
        this.options.log.error(`MQTT: Error: ${message}`);
    }

    /**
     * A broker may refuse a CONNECT whose last-will topic the ACL does not let
     * the user write (mosquitto 2 answers "Not authorized"). That cannot be
     * told apart from wrong credentials, so the next attempt goes without the
     * will: if it connects, the will was the cause; if it is refused too, the
     * credentials are, and the will comes back for the following attempts.
     */
    private adaptWill(): void {
        const client = this.client;
        if (!client) return;
        this.willRefused = !this.willRefused;
        this.willProbe = this.willRefused;
        // mqtt.js reads `options.will` again for every CONNECT packet (`client.js:403-407`).
        if (this.willRefused) delete client.options.will;
        else client.options.will = this.options.clientOptions.will;
    }

    private onClose(client: mqtt.MqttClient): void {
        if (this.stopped || client !== this.client) return;
        if (this.wasConnected) {
            this.wasConnected = false;
            this.options.log.warn('MQTT: Connection to the broker lost; reconnecting');
        }
        if (!this.failing) {
            this.failing = true;
            const first = Math.round(this.delayMs / 1000);
            const max = Math.round(this.options.backoff.maxMs / 1000);
            this.options.log.warn(
                `MQTT: Broker ${this.options.display} not available; retrying in ${first} s, then up to every ${max} s ` +
                    `(further failures are logged only when the error changes)${this.connectedOnce ? '' : '. State is not published until it connects'}`,
            );
        }
        this.scheduleReconnect(client);
    }

    private scheduleReconnect(client: mqtt.MqttClient): void {
        if (this.timer) return;
        const delay = this.delayMs;
        this.delayMs = Math.min(this.delayMs * 2, this.options.backoff.maxMs);
        this.options.log.debug(`MQTT: Reconnecting in ${delay} ms`);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (!this.stopped) client.reconnect();
        }, delay);
        this.timer.unref();
    }
}
