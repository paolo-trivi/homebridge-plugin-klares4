import WebSocket from 'ws';
import * as https from 'https';
import * as crypto from 'crypto';
import type { Logger } from 'homebridge';

import type { KseniaWebSocketOptions } from '../types';
import { CommandDispatcher } from '../websocket/command-dispatcher';
import { WsTransport } from '../websocket/ws-transport';
import type { WebSocketClientState, WebSocketConnectionOptions } from './types';

interface ConnectionServiceDeps {
    state: WebSocketClientState;
    ip: string;
    port: number;
    useHttps: boolean;
    log: Logger;
    options: KseniaWebSocketOptions;
    commandDispatcher: CommandDispatcher;
    wsTransport: WsTransport;
    onRawMessage: (raw: string) => void;
    onConnected: () => void;
    onDisconnected: () => void;
    executeLogin: () => Promise<void>;
}

export class ConnectionService {
    private readonly maxReconnectDelay = 60000;

    constructor(private readonly deps: ConnectionServiceDeps) {}

    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const resolveOnce = (): void => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };
            const rejectOnce = (error: Error): void => {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            };

            try {
                const protocol = this.deps.useHttps ? 'wss' : 'ws';
                const wsUrl = `${protocol}://${this.deps.ip}:${this.deps.port}/KseniaWsock/`;
                const allowInsecureTls = this.deps.options.allowInsecureTls ?? false;

                this.deps.log.info(`Connecting to ${wsUrl}...`);

                const wsOptions: WebSocketConnectionOptions = {
                    rejectUnauthorized: !allowInsecureTls,
                };

                if (this.deps.useHttps && allowInsecureTls) {
                    wsOptions.agent = new https.Agent({
                        rejectUnauthorized: false,
                        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
                        secureProtocol: 'TLS_method',
                        ciphers: 'ALL:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA',
                    });
                }

                this.deps.state.ws = new WebSocket(wsUrl, ['KS_WSOCK'], wsOptions);

                this.deps.state.ws.on('open', (): void => {
                    this.deps.log.info('WebSocket connected');
                    this.deps.state.isConnected = true;
                    this.deps.state.hasCompletedInitialSync = false;
                    this.deps.state.pendingOutputStatuses.clear();
                    this.deps.state.pendingSensorStatuses.clear();
                    this.deps.state.pendingZoneStatuses.clear();

                    const timeoutMs = this.deps.options.loginTimeoutMs ?? 10000;
                    const timeout = setTimeout((): void => {
                        this.deps.state.pendingLogin = undefined;
                        rejectOnce(new Error(`Login timeout after ${timeoutMs}ms`));
                        if (this.deps.state.ws && this.deps.state.ws.readyState === WebSocket.OPEN) {
                            this.deps.state.ws.close(1000, 'Login timeout');
                        }
                    }, timeoutMs);

                    this.deps.state.pendingLogin = {
                        timeout,
                        resolve: (): void => {
                            clearTimeout(timeout);
                            this.deps.state.pendingLogin = undefined;
                            this.deps.onConnected();
                            resolveOnce();
                        },
                        reject: (error: Error): void => {
                            clearTimeout(timeout);
                            this.deps.state.pendingLogin = undefined;
                            rejectOnce(error);
                        },
                    };

                    this.deps.executeLogin().catch((error: unknown): void => {
                        const loginError = error instanceof Error ? error : new Error(String(error));
                        this.deps.state.pendingLogin?.reject(loginError);
                    });
                });

                this.deps.state.ws.on('message', (data: WebSocket.Data): void => {
                    this.deps.onRawMessage(data.toString());
                });

                this.deps.state.ws.on('close', (code: number, reason: Buffer): void => {
                    const reasonText = reason.toString() || 'No reason';
                    this.deps.log.warn(`WebSocket closed: ${code} - ${reason.toString()}`);
                    this.deps.state.isConnected = false;
                    this.deps.state.idLogin = undefined;
                    this.deps.commandDispatcher.rejectAllPendingCommands(
                        new Error(`WebSocket closed (${code} - ${reasonText})`),
                    );

                    if (this.deps.state.pendingLogin) {
                        this.deps.state.pendingLogin.reject(
                            new Error(`WebSocket closed before login completed (${code} - ${reasonText})`),
                        );
                    }

                    this.deps.onDisconnected();
                    if (!this.deps.state.isManualClose) {
                        this.scheduleReconnect();
                    }
                    this.deps.state.isManualClose = false;
                });

                this.deps.state.ws.on('error', (error: Error): void => {
                    this.deps.log.error('WebSocket error:', error.message);
                    if (this.deps.state.pendingLogin) {
                        this.deps.state.pendingLogin.reject(error);
                    } else {
                        rejectOnce(error);
                    }
                });

                this.deps.state.ws.on('pong', (): void => {
                    this.deps.state.heartbeatPending = false;
                    this.deps.state.lastPongReceived = Date.now();
                    if (this.deps.options.debug) {
                        this.deps.log.debug('Native WebSocket PONG received - connection healthy');
                    }
                });
            } catch (error: unknown) {
                rejectOnce(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    public startHeartbeat(): void {
        if (this.deps.state.heartbeatTimer) {
            clearInterval(this.deps.state.heartbeatTimer);
        }

        this.deps.state.lastPongReceived = Date.now();
        this.deps.state.heartbeatPending = false;

        this.deps.state.heartbeatTimer = setInterval((): void => {
            if (this.deps.state.isConnected && this.deps.state.ws) {
                if (this.deps.state.heartbeatPending) {
                    const timeSinceLastPong = Date.now() - this.deps.state.lastPongReceived;
                    const heartbeatTimeout = (this.deps.options.heartbeatInterval ?? 30000) * 2;

                    if (timeSinceLastPong > heartbeatTimeout) {
                        this.deps.log.warn(
                            `Heartbeat timeout: no PONG received for ${Math.round(timeSinceLastPong / 1000)}s - forcing reconnection`,
                        );
                        this.forceReconnect();
                        return;
                    }
                }

                this.deps.state.heartbeatPending = true;
                this.deps.wsTransport.ping(this.deps.state.ws);
                if (this.deps.options.debug) {
                    this.deps.log.debug('Native WebSocket PING sent');
                }
            }
        }, this.deps.options.heartbeatInterval);
    }

    public disconnect(): void {
        if (this.deps.state.heartbeatTimer) {
            clearInterval(this.deps.state.heartbeatTimer);
        }
        if (this.deps.state.reconnectTimer) {
            clearTimeout(this.deps.state.reconnectTimer);
            this.deps.state.reconnectTimer = undefined;
        }
        if (this.deps.state.ws) {
            this.deps.state.isManualClose = true;
            this.deps.wsTransport.closeGracefully(this.deps.state.ws, 1000, 'Client disconnect');
        }
        if (this.deps.state.pendingLogin) {
            clearTimeout(this.deps.state.pendingLogin.timeout);
            this.deps.state.pendingLogin = undefined;
        }
        this.deps.state.isConnected = false;
        this.deps.state.idLogin = undefined;
        this.deps.commandDispatcher.clearCommandQueues();
        this.deps.commandDispatcher.rejectAllPendingCommands(new Error('Client disconnected'));
    }

    private forceReconnect(): void {
        this.deps.state.heartbeatPending = false;
        this.deps.state.idLogin = undefined;
        this.deps.commandDispatcher.rejectAllPendingCommands(
            new Error('Connection reset: heartbeat timeout'),
        );

        if (this.deps.state.heartbeatTimer) {
            clearInterval(this.deps.state.heartbeatTimer);
            this.deps.state.heartbeatTimer = undefined;
        }

        if (this.deps.state.ws) {
            this.deps.state.isManualClose = true;
            const ws = this.deps.state.ws;
            this.deps.wsTransport.closeGracefully(ws, 1001, 'Heartbeat timeout');
            this.deps.wsTransport.terminateIfNotClosed(ws, 3000);
        }

        this.deps.state.isConnected = false;
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.deps.state.reconnectTimer) {
            return;
        }

        const baseDelay = this.deps.options.reconnectInterval ?? 5000;
        const exponentialDelay = Math.min(
            baseDelay * Math.pow(2, this.deps.state.reconnectAttempts),
            this.maxReconnectDelay,
        );
        const jitter = exponentialDelay * 0.1 * (Math.random() * 2 - 1);
        const finalDelay = Math.round(exponentialDelay + jitter);

        this.deps.log.info(
            `Scheduling reconnection attempt ${this.deps.state.reconnectAttempts + 1} in ${Math.round(finalDelay / 1000)}s...`,
        );

        this.deps.state.reconnectTimer = setTimeout((): void => {
            this.deps.state.reconnectTimer = undefined;
            this.deps.state.reconnectAttempts++;
            this.deps.log.info(`Attempting reconnection (attempt ${this.deps.state.reconnectAttempts})...`);
            this.connect()
                .then((): void => {
                    this.deps.state.reconnectAttempts = 0;
                    this.deps.log.info('Reconnection successful');
                })
                .catch((err: unknown): void => {
                    this.deps.log.error(
                        'Reconnection failed:',
                        err instanceof Error ? err.message : String(err),
                    );
                    this.scheduleReconnect();
                });
        }, finalDelay);
    }
}
