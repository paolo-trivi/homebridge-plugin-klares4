import type { Logger } from 'homebridge';
import type { WebSocketClientState } from './types';

/** Explicit LOGIN_RES rejections in a row before automatic reconnection stops. */
export const LOGIN_REJECTION_LIMIT = 3;

/**
 * Alarm panels log every wrong code and may lock the user, so a login the
 * panel keeps refusing (wrong PIN, disabled user) must not be retried
 * forever. Transport failures do not count: only explicit rejections do.
 */
export function recordLoginRejection(state: WebSocketClientState, log: Logger, reason: string): void {
    state.loginRejections += 1;
    if (state.loginRejections < LOGIN_REJECTION_LIMIT || state.reconnectSuspended) {
        return;
    }
    state.reconnectSuspended = true;
    log.error(
        `The panel rejected the login ${state.loginRejections} times in a row (${reason}). `
        + 'Automatic reconnection is stopped so the panel does not lock the user out: '
        + 'check the PIN (and that the user is enabled on the panel) in the plugin configuration, '
        + 'then restart Homebridge.',
    );
}

export function resetLoginRejections(state: WebSocketClientState): void {
    state.loginRejections = 0;
    state.reconnectSuspended = false;
}
