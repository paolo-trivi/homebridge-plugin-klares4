import type { Logger } from 'homebridge';
import type * as mqtt from 'mqtt';

import { toErrorMessage } from '../errors';
import { LastWillPolicy } from './last-will-policy';

export type MqttConnectFn = (brokerUrl: string, options: mqtt.IClientOptions) => mqtt.MqttClient;

export interface ReconnectBackoff {
    initialMs: number;
    maxMs: number;
}

export const DEFAULT_RECONNECT_BACKOFF: ReconnectBackoff = { initialMs: 5000, maxMs: 60000 };

export interface SessionTiming {
    /** Longest wait at shutdown for the broker to confirm `offline` and the DISCONNECT. */
    stopTimeoutMs: number;
    /** While the broker refuses the last will, how often it is tried again. */
    willRetryMs: number;
}

export const DEFAULT_SESSION_TIMING: SessionTiming = { stopTimeoutMs: 2000, willRetryMs: 30 * 60 * 1000 };

interface BrokerSessionOptions {
    url: string;
    /** `scheme://host[:port]`, never with credentials. */
    display: string;
    clientOptions: mqtt.IClientOptions;
    log: Logger;
    connect: MqttConnectFn;
    backoff: ReconnectBackoff;
    timing: SessionTiming;
    onConnect: (client: mqtt.MqttClient) => void;
    onMessage: (topic: string, payload: Buffer, packet: mqtt.IPublishPacket) => void;
}

/** One connection attempt: its own mqtt.js client, used until it closes. */
interface Attempt {
    client: mqtt.MqttClient;
    withWill: boolean;
    connected: boolean;
    notAuthorized: boolean;
}

/** CONNACK "Not authorized" (MQTT 3.1.1 return code 5, MQTT 5 reason code 135). */
function isNotAuthorized(error: Error): boolean {
    const code: unknown = 'code' in error ? error.code : undefined;
    return code === 5 || code === 135;
}

/**
 * The broker connection, kept alive by the plugin rather than by mqtt.js
 * 5.16, which retries at a fixed interval (`client.js` `_setupReconnect`, a
 * `setInterval`) and stops for good after a refused CONNACK unless
 * `reconnectOnConnackError` is set (`handlers/connack.js:42-55`).
 *
 * Every attempt is a new client with `reconnectPeriod: 0`. A closed attempt
 * is ended with `force`, which with `clean: true` and `reconnectPeriod: 0`
 * fails the callbacks of its unconfirmed publishes (`client.js` `_cleanUp` →
 * `_flush`): nothing of an old connection stays queued, so a later shutdown
 * is not held by a publish no broker will ever confirm. The next attempt
 * starts after a delay that doubles up to `maxMs`. Log lines are written on
 * transitions only.
 */
export class BrokerSession {
    private attempt?: Attempt;
    private stopped = false;
    private timer?: NodeJS.Timeout;
    private willRetryTimer?: NodeJS.Timeout;
    private delayMs: number;
    private connectedOnce = false;
    private failing = false;
    private lastError?: string;
    /** The current attempt replaces a working connection to try the last will again. */
    private retryingWill = false;
    private readonly will: LastWillPolicy;

    constructor(private readonly options: BrokerSessionOptions) {
        this.delayMs = options.backoff.initialMs;
        const willTopic = options.clientOptions.will?.topic ?? '';
        this.will = new LastWillPolicy(options.clientOptions.will !== undefined, willTopic, options.timing.willRetryMs, options.log);
    }

    public get connectedClient(): mqtt.MqttClient | undefined {
        const attempt = this.attempt;
        return attempt?.connected && attempt.client.connected ? attempt.client : undefined;
    }

    public start(): void {
        this.open(this.will.nextWithWill);
    }

    /**
     * Publishes `last` and sends DISCONNECT; if the broker has not confirmed
     * within `stopTimeoutMs`, the socket is closed anyway. No reconnection
     * afterwards.
     */
    public stop(last?: { topic: string; payload: string; qos: 0 | 1 | 2 }): void {
        this.stopped = true;
        this.clearTimers();
        const attempt = this.attempt;
        if (!attempt) return;
        const { client } = attempt;
        const { log } = this.options;
        if (!this.connectedClient) {
            client.end(true);
            log.info('MQTT: Disconnected');
            return;
        }
        let closed = false;
        const deadline = setTimeout(() => {
            if (closed) return;
            closed = true;
            client.stream.destroy();
            log.warn(`MQTT: Disconnected; the broker did not confirm the last messages within ${this.options.timing.stopTimeoutMs} ms`);
        }, this.options.timing.stopTimeoutMs);
        deadline.unref();
        if (last) client.publish(last.topic, last.payload, { qos: last.qos, retain: true });
        client.end(false, {}, () => {
            if (closed) return;
            closed = true;
            clearTimeout(deadline);
            log.info('MQTT: Disconnected');
        });
    }

    private open(withWill: boolean): void {
        const { will, ...rest } = this.options.clientOptions;
        const clientOptions: mqtt.IClientOptions = { ...rest, ...(withWill && will ? { will } : {}), reconnectPeriod: 0 };
        let client: mqtt.MqttClient;
        try {
            client = this.options.connect(this.options.url, clientOptions);
        } catch (error: unknown) {
            this.options.log.error(`MQTT: Connection error: ${toErrorMessage(error)}`);
            return;
        }
        const attempt: Attempt = { client, withWill, connected: false, notAuthorized: false };
        this.attempt = attempt;
        client.on('connect', () => this.onConnect(attempt));
        client.on('error', (error: Error) => this.onError(attempt, error));
        client.on('close', () => this.onClose(attempt));
        client.on('message', (topic: string, payload: Buffer, packet: mqtt.IPublishPacket) => {
            if (this.attempt === attempt) this.options.onMessage(topic, payload, packet);
        });
    }

    private onConnect(attempt: Attempt): void {
        if (this.stopped || attempt !== this.attempt) return;
        attempt.connected = true;
        if (!this.retryingWill) {
            this.options.log.info(`MQTT: ${this.failing ? 'Reconnected' : 'Connected'} to broker ${this.options.display}`);
        }
        this.retryingWill = false;
        this.will.onConnected(attempt.withWill);
        this.delayMs = this.options.backoff.initialMs;
        this.connectedOnce = true;
        this.failing = false;
        this.lastError = undefined;
        if (this.will.retryPending) this.scheduleWillRetry();
        this.options.onConnect(attempt.client);
    }

    private onError(attempt: Attempt, error: Error): void {
        if (attempt !== this.attempt) return;
        if (isNotAuthorized(error)) attempt.notAuthorized = true;
        const message = toErrorMessage(error);
        // The periodic retry of the will is expected to be refused while the ACL is unchanged.
        if (message === this.lastError || this.retryingWill) {
            this.options.log.debug(`MQTT: Error: ${message}`);
            return;
        }
        this.lastError = message;
        this.options.log.error(`MQTT: Error: ${message}`);
    }

    private onClose(attempt: Attempt): void {
        if (attempt !== this.attempt) return;
        // Fails what this connection still had in flight: it is republished on the next connect.
        attempt.client.end(true);
        if (this.stopped) return;
        if (this.willRetryTimer) clearTimeout(this.willRetryTimer);
        this.willRetryTimer = undefined;
        if (!attempt.connected && this.will.onRefused(attempt.withWill, attempt.notAuthorized) === 'retry-without-will-now') {
            this.schedule(0, false);
            return;
        }
        this.retryingWill = false;
        if (attempt.connected) {
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
        const delay = this.delayMs;
        this.delayMs = Math.min(this.delayMs * 2, this.options.backoff.maxMs);
        this.options.log.debug(`MQTT: Reconnecting in ${delay} ms`);
        this.schedule(delay, this.will.nextWithWill);
    }

    private schedule(delayMs: number, withWill: boolean): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (!this.stopped) this.open(withWill);
        }, delayMs);
        this.timer.unref();
    }

    /** Replaces the working connection with one that carries the will again. */
    private scheduleWillRetry(): void {
        if (this.willRetryTimer) clearTimeout(this.willRetryTimer);
        this.willRetryTimer = setTimeout(() => {
            this.willRetryTimer = undefined;
            const attempt = this.attempt;
            if (this.stopped || !attempt?.connected) return;
            this.retryingWill = true;
            this.attempt = undefined;
            attempt.client.end(true);
            this.open(true);
        }, this.options.timing.willRetryMs);
        this.willRetryTimer.unref();
    }

    private clearTimers(): void {
        if (this.timer) clearTimeout(this.timer);
        if (this.willRetryTimer) clearTimeout(this.willRetryTimer);
        this.timer = undefined;
        this.willRetryTimer = undefined;
    }
}
