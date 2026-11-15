import type { Logger } from 'homebridge';
import type { WebSocketClientState } from './types';
import { toErrorMessage } from '../errors';

interface ReconnectSchedulerDeps {
    state: WebSocketClientState;
    log: Logger;
    baseDelayMs: number;
    /** Delay between attempts once the login guard has slowed reconnection. */
    suspendedRetryMs: number;
    isStopped: () => boolean;
    /** One reconnection attempt: opens the socket and logs in. */
    attempt: () => Promise<void>;
}

/**
 * Exponential backoff with a 60 s ceiling and ±10 % jitter, one timer at a
 * time. The backoff is reset only by a completed sync (`resetBackoff`): a
 * session that logs in and then fails its sync keeps backing off.
 */
export class ReconnectScheduler {
    private readonly maxReconnectDelay = 60000;

    constructor(private readonly deps: ReconnectSchedulerDeps) {}

    public schedule(): void {
        const { state } = this.deps;
        if (this.deps.isStopped() || state.reconnectTimer) {
            return;
        }

        const finalDelay = state.reconnectSuspended ? this.deps.suspendedRetryMs : this.backoffDelay();
        this.deps.log.info(
            `Scheduling reconnection attempt ${state.reconnectAttempts + 1} in ${Math.round(finalDelay / 1000)}s...`,
        );

        state.reconnectTimer = setTimeout((): void => {
            state.reconnectTimer = undefined;
            if (this.deps.isStopped()) return;
            state.reconnectAttempts++;
            this.deps.log.info(`Attempting reconnection (attempt ${state.reconnectAttempts})...`);
            this.deps.attempt()
                .then((): void => {
                    this.deps.log.info('Reconnection successful');
                })
                .catch((err: unknown): void => {
                    // A shutdown aborts the attempt in progress: not a failure to retry.
                    if (this.deps.isStopped()) return;
                    this.deps.log.error(
                        'Reconnection failed:',
                        toErrorMessage(err),
                    );
                    this.schedule();
                });
        }, finalDelay);
    }

    public cancel(): void {
        if (this.deps.state.reconnectTimer) {
            clearTimeout(this.deps.state.reconnectTimer);
            this.deps.state.reconnectTimer = undefined;
        }
    }

    public resetBackoff(): void {
        this.deps.state.reconnectAttempts = 0;
    }

    private backoffDelay(): number {
        const exponentialDelay = Math.min(
            this.deps.baseDelayMs * Math.pow(2, this.deps.state.reconnectAttempts),
            this.maxReconnectDelay,
        );
        const jitter = exponentialDelay * 0.1 * (Math.random() * 2 - 1);
        return Math.round(exponentialDelay + jitter);
    }
}
