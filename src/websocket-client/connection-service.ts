import WebSocket from 'ws';
import type { Logger } from 'homebridge';

import type { KseniaWebSocketOptions } from '../types';
import { CommandDispatcher } from '../websocket/command-dispatcher';
import { WsTransport } from '../websocket/ws-transport';
import { connectionOptions, DEFAULT_MAX_PAYLOAD_BYTES, panelUrl } from './connection-setup';
import { HeartbeatMonitor } from './heartbeat-monitor';
import { recordLoginRejection, SUSPENDED_LOGIN_RETRY_MS } from './login-rejection-guard';
import { ReconnectScheduler } from './reconnect-scheduler';
import { tlsConfigurationHint } from './tls-error-hint';
import type { WebSocketClientState } from './types';

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

/** Budget from an accepted login to the accepted REALTIME registration (default). */
const DEFAULT_SYNC_TIMEOUT_MS = 60000;

export class ConnectionService {
    /** Set by disconnect(): no reconnect may be scheduled after shutdown. */
    private stopped = false;
    private tlsHintLogged = false;
    private syncTimer?: ReturnType<typeof setTimeout>;
    private readonly heartbeat: HeartbeatMonitor;
    private readonly reconnect: ReconnectScheduler;

    constructor(private readonly deps: ConnectionServiceDeps) {
        this.heartbeat = new HeartbeatMonitor({
            state: deps.state,
            log: deps.log,
            intervalMs: deps.options.heartbeatInterval ?? 30000,
            debug: deps.options.debug ?? false,
            wsTransport: deps.wsTransport,
            onTimeout: (silentMs): void => {
                this.deps.log.warn(
                    `Heartbeat timeout: no PONG received for ${Math.round(silentMs / 1000)}s - forcing reconnection`,
                );
                this.retireSocket(1001, 'Heartbeat timeout', new Error('Connection reset: heartbeat timeout'));
            },
        });
        this.reconnect = new ReconnectScheduler({
            state: deps.state,
            log: deps.log,
            baseDelayMs: deps.options.reconnectInterval ?? 5000,
            suspendedRetryMs: deps.options.suspendedLoginRetryMs ?? SUSPENDED_LOGIN_RETRY_MS,
            isStopped: (): boolean => this.stopped,
            attempt: (): Promise<void> => this.open(),
        });
    }

    public async connect(): Promise<void> {
        this.stopped = false;
        return this.open();
    }

    private async open(): Promise<void> {
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
                const wsUrl = panelUrl(this.deps.ip, this.deps.port, this.deps.useHttps);
                const allowInsecureTls = this.deps.options.allowInsecureTls ?? false;
                const maxPayload = this.deps.options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;

                this.deps.log.info(`Connecting to ${wsUrl}...`);

                const ws = new WebSocket(wsUrl, ['KS_WSOCK'], connectionOptions(this.deps.useHttps, allowInsecureTls, maxPayload));
                this.deps.state.ws = ws;
                // A new attempt is never a manual close; a flag left over from a
                // superseded socket would otherwise suppress the next reconnect.
                this.deps.state.isManualClose = false;
                // Events of a socket replaced by a newer attempt (or retired after a
                // heartbeat timeout) must not touch the shared state of the session.
                const isCurrent = (): boolean => this.deps.state.ws === ws;
                // Without it a black-holed connect hangs until the kernel's TCP
                // timeout (about 133 s observed); terminate() then emits error and
                // close, and the close handler schedules the normal backoff.
                const connectTimeoutMs = this.deps.options.connectTimeoutMs ?? 10000;
                const connectTimer = setTimeout((): void => {
                    if (ws.readyState !== WebSocket.CONNECTING) return;
                    const timeoutError = new Error(`WebSocket connection timed out after ${connectTimeoutMs}ms`);
                    this.deps.log.warn(timeoutError.message);
                    rejectOnce(timeoutError);
                    ws.terminate();
                }, connectTimeoutMs);

                ws.on('open', (): void => {
                    clearTimeout(connectTimer);
                    if (!isCurrent()) {
                        ws.terminate();
                        rejectOnce(new Error('WebSocket superseded by a newer connection attempt'));
                        return;
                    }
                    this.deps.log.info('WebSocket connected');
                    // A heartbeat left over from the previous socket would judge this one
                    // by a PONG from before the outage; it restarts once the login completes.
                    this.heartbeat.stop();
                    this.deps.state.isConnected = true;
                    this.deps.state.hasCompletedInitialSync = false;
                    this.deps.state.pendingOutputStatuses.clear();
                    this.deps.state.pendingSensorStatuses.clear();
                    this.deps.state.pendingZoneStatuses.clear();
                    this.startLogin(ws, resolveOnce, rejectOnce);
                });

                ws.on('message', (data: WebSocket.Data): void => {
                    if (!isCurrent()) return;
                    this.deps.onRawMessage(data.toString());
                });

                ws.on('close', (code: number, reason: Buffer): void => {
                    clearTimeout(connectTimer);
                    const reasonText = reason.toString() || 'No reason';
                    const closedError = new Error(`WebSocket closed (${code} - ${reasonText})`);
                    if (isCurrent()) {
                        if (this.stopped) {
                            this.deps.log.debug(`WebSocket closed: ${code} - ${reasonText}`);
                        } else {
                            this.deps.log.warn(`WebSocket closed: ${code} - ${reasonText}`);
                        }
                        this.sessionLost(
                            closedError,
                            new Error(`WebSocket closed before login completed (${code} - ${reasonText})`),
                        );
                    }
                    // connect() always settles, whatever ended the attempt.
                    rejectOnce(closedError);
                });

                ws.on('error', (error: Error): void => {
                    clearTimeout(connectTimer);
                    if (!isCurrent()) {
                        rejectOnce(error);
                        return;
                    }
                    if (this.stopped) {
                        // Shutdown while connecting: ws reports the aborted handshake as an error.
                        this.deps.log.debug(`WebSocket error after disconnect: ${error.message}`);
                    } else {
                        this.deps.log.error('WebSocket error:', error.message);
                    }
                    const hint = tlsConfigurationHint(error, { useHttps: this.deps.useHttps, allowInsecureTls });
                    if (hint && !this.tlsHintLogged) {
                        this.tlsHintLogged = true; // reconnects would repeat it every backoff
                        this.deps.log.warn(hint);
                    }
                    if (this.deps.state.pendingLogin) {
                        this.failPendingLogin(error);
                    } else {
                        rejectOnce(error);
                    }
                });

                ws.on('pong', (): void => {
                    if (!isCurrent()) return;
                    this.heartbeat.pongReceived();
                });
            } catch (error: unknown) {
                const failure = error instanceof Error ? error : new Error(String(error));
                this.deps.log.error('Cannot open the connection to the panel:', failure.message);
                rejectOnce(failure);
            }
        });
    }

    private startLogin(ws: WebSocket, resolveOnce: () => void, rejectOnce: (error: Error) => void): void {
        const timeoutMs = this.deps.options.loginTimeoutMs ?? 10000;
        const timeout = setTimeout((): void => {
            if (this.deps.state.pendingLogin !== attempt || this.deps.state.ws !== ws) return;
            this.retireSocket(1000, 'Login timeout', new Error(`Login timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const attempt = {
            timeout,
            resolve: (): void => {
                clearTimeout(timeout);
                this.deps.state.pendingLogin = undefined;
                this.startSyncWatchdog(ws);
                this.deps.onConnected();
                resolveOnce();
            },
            reject: (error: Error): void => {
                clearTimeout(timeout);
                this.deps.state.pendingLogin = undefined;
                rejectOnce(error);
            },
        };
        this.deps.state.pendingLogin = attempt;

        this.deps.executeLogin().catch((error: unknown): void => {
            if (this.deps.state.pendingLogin !== attempt) return;
            // The LOGIN never left: not a failed login for the guard.
            const loginError = error instanceof Error ? error : new Error(String(error));
            attempt.reject(loginError);
            if (this.deps.state.ws === ws) this.retireSocket(1000, 'Login not sent', loginError);
        });
    }

    /** The login was refused or invalid: counted, then the session is closed and retried. */
    public failLogin(error: Error): void {
        this.retireSocket(1000, 'Login failed', error);
    }

    /** The session cannot complete its sync: closed, then retried with the backoff. */
    public abortSession(reason: string): void {
        this.deps.log.warn(reason);
        this.retireSocket(1000, 'Synchronization failed', new Error(reason));
    }

    /** The sync of this session completed: the session is healthy, the backoff restarts. */
    public syncCompleted(): void {
        this.clearSyncWatchdog();
        this.reconnect.resetBackoff();
    }

    public startHeartbeat(): void {
        this.heartbeat.start();
    }

    public disconnect(): void {
        this.stopped = true;
        this.heartbeat.stop();
        this.clearSyncWatchdog();
        this.reconnect.cancel();
        if (this.deps.state.ws) {
            this.deps.state.isManualClose = true;
            this.deps.wsTransport.closeGracefully(this.deps.state.ws, 1000, 'Client disconnect');
        }
        // A shutdown is not a failed login: settle connect() without counting it.
        this.deps.state.pendingLogin?.reject(new Error('Client disconnected'));
        this.deps.state.isConnected = false;
        this.deps.state.idLogin = undefined;
        this.deps.commandDispatcher.clearCommandQueues();
        this.deps.commandDispatcher.rejectAllPendingCommands(new Error('Client disconnected'));
    }

    /**
     * Detaches the current socket from the session and tears the session down
     * at once (disconnected event, pending commands rejected, reconnect). The
     * socket is closed in the background; its late events are ignored.
     */
    private retireSocket(code: number, reason: string, error: Error): void {
        const ws = this.deps.state.ws;
        this.deps.state.ws = undefined;
        if (ws) {
            this.deps.wsTransport.closeGracefully(ws, code, reason);
            this.deps.wsTransport.terminateIfNotClosed(ws, 3000);
        }
        this.sessionLost(error, error);
    }

    private sessionLost(error: Error, loginError: Error): void {
        this.heartbeat.stop();
        this.clearSyncWatchdog();
        this.deps.state.isConnected = false;
        this.deps.state.idLogin = undefined;
        this.deps.commandDispatcher.rejectAllPendingCommands(error);
        // Before the reconnect is scheduled: the guard decides its pace.
        if (this.deps.state.pendingLogin) this.failPendingLogin(loginError);
        this.deps.onDisconnected();
        if (!this.stopped) this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        this.reconnect.schedule();
    }

    /** A login attempt ends without success; it counts once the LOGIN frame was sent. */
    private failPendingLogin(error: Error): void {
        const pending = this.deps.state.pendingLogin;
        if (!pending) return;
        if (pending.messageId !== undefined && !this.stopped) {
            const retryMs = this.deps.options.suspendedLoginRetryMs ?? SUSPENDED_LOGIN_RETRY_MS;
            recordLoginRejection(this.deps.state, this.deps.log, error.message, retryMs);
        }
        pending.reject(error);
    }

    private startSyncWatchdog(ws: WebSocket): void {
        this.clearSyncWatchdog();
        const timeoutMs = this.deps.options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
        this.syncTimer = setTimeout((): void => {
            this.syncTimer = undefined;
            if (this.deps.state.ws !== ws || this.deps.state.hasCompletedInitialSync) return;
            this.abortSession(
                `The panel did not complete the synchronization within ${Math.round(timeoutMs / 1000)}s `
                + '(no realtime registration): reconnecting',
            );
        }, timeoutMs);
        this.syncTimer.unref?.();
    }

    private clearSyncWatchdog(): void {
        if (this.syncTimer) {
            clearTimeout(this.syncTimer);
            this.syncTimer = undefined;
        }
    }
}
