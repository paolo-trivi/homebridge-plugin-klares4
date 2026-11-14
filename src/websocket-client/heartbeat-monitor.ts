import type { Logger } from 'homebridge';
import type { WsTransport } from '../websocket/ws-transport';
import type { WebSocketClientState } from './types';

interface HeartbeatMonitorDeps {
    state: WebSocketClientState;
    log: Logger;
    intervalMs: number;
    debug: boolean;
    wsTransport: WsTransport;
    /** No PONG for two intervals: the connection is dead (half-open). */
    onTimeout: (silentMs: number) => void;
}

/** WebSocket ping/pong on the live session. */
export class HeartbeatMonitor {
    constructor(private readonly deps: HeartbeatMonitorDeps) {}

    public start(): void {
        this.stop();
        const { state } = this.deps;
        state.lastPongReceived = Date.now();
        state.heartbeatPending = false;

        state.heartbeatTimer = setInterval((): void => {
            if (!state.isConnected || !state.ws) return;
            if (state.heartbeatPending) {
                const silentMs = Date.now() - state.lastPongReceived;
                if (silentMs > this.deps.intervalMs * 2) {
                    this.deps.onTimeout(silentMs);
                    return;
                }
            }
            state.heartbeatPending = true;
            this.deps.wsTransport.ping(state.ws);
            if (this.deps.debug) {
                this.deps.log.debug('Native WebSocket PING sent');
            }
        }, this.deps.intervalMs);
    }

    public stop(): void {
        const { state } = this.deps;
        if (state.heartbeatTimer) {
            clearInterval(state.heartbeatTimer);
            state.heartbeatTimer = undefined;
        }
        state.heartbeatPending = false;
    }

    public pongReceived(): void {
        this.deps.state.heartbeatPending = false;
        this.deps.state.lastPongReceived = Date.now();
        if (this.deps.debug) {
            this.deps.log.debug('Native WebSocket PONG received - connection healthy');
        }
    }
}
