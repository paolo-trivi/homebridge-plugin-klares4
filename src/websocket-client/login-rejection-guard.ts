import type { Logger } from 'homebridge';
import type { WebSocketClientState } from './types';

/** Failed logins in a row before reconnection slows down. */
export const LOGIN_REJECTION_LIMIT = 3;

/** Delay between login attempts once the limit is reached (default). */
export const SUSPENDED_LOGIN_RETRY_MS = 60 * 60 * 1000;

/**
 * Alarm panels log every wrong code and may lock the user, so a login the
 * panel keeps refusing (wrong PIN, disabled user) must not be retried at the
 * normal pace. A failed login is any attempt that sent the LOGIN frame and
 * got no accepted answer: an explicit refusal (correlated or not), an answer
 * without ID_LOGIN, no answer before the login timeout, or the socket closed
 * before LOGIN_RES. Transport failures before the LOGIN is sent do not count.
 *
 * Past the limit the client does not stop: it keeps one attempt every
 * `retryDelayMs`, and every further failure logs the remedy again, so a
 * transient refusal (panel in programming mode) recovers on its own and a
 * wrong PIN stays visible in the log.
 */
export function recordLoginRejection(
    state: WebSocketClientState,
    log: Logger,
    reason: string,
    retryDelayMs: number,
): void {
    state.loginRejections += 1;
    if (state.loginRejections < LOGIN_REJECTION_LIMIT) {
        return;
    }
    state.reconnectSuspended = true;
    log.error(
        `The panel refused or did not answer the login ${state.loginRejections} times in a row (last: ${reason}). `
        + `Reconnection is slowed to one attempt every ${formatDelay(retryDelayMs)} so the panel does not lock the user out: `
        + 'check the PIN (and that the user is enabled on the panel) in the plugin configuration, '
        + 'then restart Homebridge to reconnect at once.',
    );
}

export function resetLoginRejections(state: WebSocketClientState): void {
    state.loginRejections = 0;
    state.reconnectSuspended = false;
}

function formatDelay(ms: number): string {
    if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
    return `${Math.max(1, Math.round(ms / 1000))} s`;
}
