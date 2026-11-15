import type { Logger } from 'homebridge';
import type { KseniaMessage } from '../types';
import { frameResult, resultDetail } from '../websocket/protocol-result';
import type { LoginFailureKind } from './login-rejection-guard';
import type { WebSocketClientState } from './types';

export interface LoginResponseHandlerDeps {
    state: WebSocketClientState;
    log: Logger;
    /** The login succeeded: resolves the attempt, starts the heartbeat and the sync. */
    onLoginAccepted: () => void;
    /** The login failed: counted by the login guard by kind, socket closed, backoff. */
    failLogin: (error: Error, kind: LoginFailureKind) => void;
}

/**
 * LOGIN_RES handling. A Lares4 rejection has never been captured, so only
 * what is observable is relied on: a correlated answer with RESULT OK and an
 * ID_LOGIN is a success; a negative RESULT is a rejection, also when its ID
 * does not match (the LOGIN in progress is the only one on this socket); an
 * OK without ID_LOGIN is a failed login. Closing the socket or never answering
 * are handled by the connection service, which counts them the same way.
 */
export class LoginResponseHandler {
    constructor(private readonly deps: LoginResponseHandlerDeps) {}

    public handle(message: KseniaMessage): void {
        const pending = this.deps.state.pendingLogin;
        const loginSent = pending !== undefined && pending.messageId !== undefined;
        const correlated = loginSent && pending.messageId === String(message.ID);
        const result = frameResult(message);
        const detail = resultDetail(message);

        if (!correlated) {
            if (loginSent && result !== undefined && result !== 'OK') {
                this.deps.log.warn(
                    'The panel refused a login with a LOGIN_RES that does not carry the ID of the LOGIN in progress; '
                    + 'it is counted as a rejection',
                );
                this.deps.failLogin(new Error(`Login failed: ${detail ?? result}`), 'refused');
                return;
            }
            this.deps.log.warn('Ignoring LOGIN_RES that does not answer the LOGIN in progress');
            return;
        }

        if (result !== 'OK') {
            const reason = detail ?? result ?? 'no RESULT';
            this.deps.log.error('Login failed:', reason);
            this.deps.failLogin(new Error(`Login failed: ${reason}`), 'refused');
            return;
        }

        const idLogin = readIdLogin(message.PAYLOAD.ID_LOGIN);
        if (idLogin === undefined) {
            this.deps.log.error('Login failed: the panel accepted the login without an ID_LOGIN');
            // Accepted but unusable: not a refusal of the PIN.
            this.deps.failLogin(new Error('Login failed: LOGIN_RES without ID_LOGIN'), 'unanswered');
            return;
        }
        this.deps.state.idLogin = idLogin;
        this.deps.log.info(`Login completed, ID_LOGIN: ${idLogin}`);
        this.deps.onLoginAccepted();
    }
}

function readIdLogin(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
