import type { Logger } from 'homebridge';

/** What the session does after an attempt that never connected. */
export type RefusalOutcome = 'retry-without-will-now' | 'backoff';

/**
 * Decides whether a CONNECT carries the last will. A broker may refuse a
 * CONNECT whose will topic the user cannot write (mosquitto 2 answers
 * "Not authorized"), which looks exactly like wrong credentials. The will is
 * set aside only on specific evidence: a CONNECT with the will refused as
 * "Not authorized", and the CONNECT sent right after without it accepted.
 * While it is set aside the session retries it periodically, so a fixed ACL
 * brings it back without a restart.
 */
export class LastWillPolicy {
    /** False once the broker accepted a CONNECT without the will right after refusing one with it. */
    private accepted = true;
    /** The current attempt is the one without the will that follows a refusal with it. */
    private probing = false;
    private warned = false;

    constructor(
        private readonly hasWill: boolean,
        private readonly topic: string,
        private readonly retryMs: number,
        private readonly log: Logger,
    ) {}

    /** Whether the next ordinary attempt carries the will. */
    public get nextWithWill(): boolean {
        return this.hasWill && this.accepted && !this.probing;
    }

    /** True while the bridge runs without the will and should try it again. */
    public get retryPending(): boolean {
        return this.hasWill && !this.accepted;
    }

    public onRefused(withWill: boolean, notAuthorized: boolean): RefusalOutcome {
        if (this.probing) {
            // Refused without the will too: the will was not the cause.
            this.probing = false;
            return 'backoff';
        }
        if (withWill && notAuthorized) {
            this.probing = true;
            return 'retry-without-will-now';
        }
        return 'backoff';
    }

    public onConnected(withWill: boolean): void {
        if (withWill) {
            if (!this.accepted) {
                this.log.info(`MQTT: The broker accepted the last will on ${this.topic} again: an unexpected stop is reported as offline`);
            }
            this.accepted = true;
            this.warned = false;
            return;
        }
        if (!this.probing) return;
        this.probing = false;
        this.accepted = false;
        const minutes = Math.max(1, Math.round(this.retryMs / 60000));
        const message =
            `MQTT: The broker refused the connection that carried the last will on ${this.topic} ("Not authorized") ` +
            'and accepted the one sent right after without it. The bridge runs without the last will, so an unexpected stop ' +
            `leaves ${this.topic} "online". A broker ACL that does not let this user write ${this.topic} gives this result; ` +
            `the last will is tried again every ${minutes} min.`;
        if (this.warned) {
            this.log.debug(message);
        } else {
            this.warned = true;
            this.log.warn(message);
        }
    }
}
