import type { Logger } from 'homebridge';
import type { WebSocketClientState } from './types';

/** Explicit login refusals in a row before reconnection slows down. */
export const LOGIN_REJECTION_LIMIT = 3;

/** Delay between login attempts once the refusal limit is reached (default). */
export const SUSPENDED_LOGIN_RETRY_MS = 60 * 60 * 1000;

/** Unanswered logins in a row after which one warning explains the likely causes. */
export const UNANSWERED_LOGIN_WARNING = 5;

/**
 * How a login attempt that sent the LOGIN frame ended without success.
 * - `refused`: the panel answered no (a negative LOGIN_RES, with our ID or
 *   not). Alarm panels log every wrong code and may lock the user, so after
 *   `LOGIN_REJECTION_LIMIT` in a row the client tries once per
 *   `retryDelayMs` and logs, at every further refusal, to check the PIN.
 * - `unanswered`: no verdict (login timeout, socket closed or transport
 *   error before LOGIN_RES, an OK without ID_LOGIN). A panel that restarts or
 *   is at its session limit looks like this, so these stay in the normal
 *   reconnection backoff, never slow it to the refusal pace and never blame
 *   the PIN; a long streak only logs one warning.
 * Transport failures before the LOGIN is sent count as neither.
 */
export type LoginFailureKind = 'refused' | 'unanswered';

export function recordLoginFailure(
    state: WebSocketClientState,
    log: Logger,
    kind: LoginFailureKind,
    reason: string,
    retryDelayMs: number,
): void {
    if (kind === 'unanswered') {
        state.unansweredLogins = (state.unansweredLogins ?? 0) + 1;
        if (state.unansweredLogins === UNANSWERED_LOGIN_WARNING) {
            log.warn(
                `The panel did not answer the last ${state.unansweredLogins} logins (last: ${reason}). `
                + 'It may be restarting, busy or at its limit of open sessions (app, web, other clients); '
                + 'reconnection continues with the normal backoff.',
            );
        }
        return;
    }

    // The panel answered: it is alive, the unanswered streak is over.
    state.unansweredLogins = 0;
    state.loginRejections += 1;
    if (state.loginRejections < LOGIN_REJECTION_LIMIT) {
        return;
    }
    state.reconnectSuspended = true;
    log.error(
        `The panel refused the login ${state.loginRejections} times in a row (last: ${reason}). `
        + `Reconnection is slowed to one attempt every ${formatDelay(retryDelayMs)} so the panel does not lock the user out: `
        + 'check the PIN (and that the user is enabled on the panel) in the plugin configuration, '
        + 'then restart Homebridge to reconnect at once.',
    );
}

export function resetLoginRejections(state: WebSocketClientState): void {
    state.loginRejections = 0;
    state.unansweredLogins = 0;
    state.reconnectSuspended = false;
}

function formatDelay(ms: number): string {
    if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
    return `${Math.max(1, Math.round(ms / 1000))} s`;
}
