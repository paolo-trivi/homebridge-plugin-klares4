import { RetryableKlaresError } from '../errors';
import type { KseniaOutputStatusRaw } from '../types';

export interface StateConfirmation {
    status: 'state-confirmed';
    latencyMs: number;
}

export interface OutputConfirmationHandle {
    promise: Promise<StateConfirmation>;
    /** The command failed (explicit rejection): it owes no state change. */
    cancel: () => void;
    /**
     * The command ended without its state being seen (acknowledged, or timed out
     * and possibly executed): the panel's realtime event for it may still come,
     * and must not confirm the next command on the same output.
     */
    expectLateState: () => void;
}

interface PendingOutputConfirmation {
    startedAt: number;
    matches: (status: KseniaOutputStatusRaw) => boolean;
    /** A state other than the target was seen: the next matching one is a real transition. */
    armed: boolean;
    /** How the confirmation ended, once it has. */
    outcome?: 'confirmed' | 'timed-out' | 'released';
    resolve: (confirmation: StateConfirmation) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

interface OwedState {
    matches: (status: KseniaOutputStatusRaw) => boolean;
    expiresAt: number;
}

/**
 * Confirms an observable output command from the realtime state, for panels
 * that do not acknowledge output commands. Only a transition counts: the target
 * state seen after a different one, both after the command was registered. A
 * state the output already had, or the late event of an earlier command on the
 * same output, does not confirm it.
 */
export class OutputCommandConfirmationTracker {
    /** Real panels have a few dozen outputs; the cap only bounds hostile frames. */
    private static readonly LAST_STATE_LIMIT = 1024;
    private readonly pending = new Map<string, PendingOutputConfirmation>();
    private readonly lastState = new Map<string, KseniaOutputStatusRaw>();
    private readonly owed = new Map<string, OwedState[]>();

    public register(
        outputId: string,
        timeoutMs: number,
        matches: (status: KseniaOutputStatusRaw) => boolean,
    ): OutputConfirmationHandle {
        if (this.pending.has(outputId)) {
            throw new Error(`Output ${outputId} already has a pending state confirmation`);
        }
        const before = this.lastState.get(outputId);
        const armed = before !== undefined && !safeMatches(matches, before);

        let entry: PendingOutputConfirmation | undefined;
        const promise = new Promise<StateConfirmation>((resolve, reject) => {
            const timeout = setTimeout((): void => {
                this.pending.delete(outputId);
                if (entry) entry.outcome = 'timed-out';
                reject(new RetryableKlaresError(
                    `Output ${outputId} state confirmation timed out after ${timeoutMs}ms`,
                ));
            }, timeoutMs);
            entry = { startedAt: Date.now(), matches, armed, resolve, reject, timeout };
            this.pending.set(outputId, entry);
        });

        const release = (): void => {
            if (!entry || this.pending.get(outputId) !== entry) return;
            clearTimeout(entry.timeout);
            this.pending.delete(outputId);
            entry.outcome = 'released';
        };
        return {
            promise,
            cancel: release,
            expectLateState: (): void => {
                // Also after a timeout: the command may have run, its event may still come.
                if (!entry || entry.outcome === 'confirmed' || entry.outcome === 'released') return;
                release();
                const list = this.owed.get(outputId) ?? [];
                list.push({ matches, expiresAt: Date.now() + timeoutMs });
                this.owed.set(outputId, list);
            },
        };
    }

    public observe(status: KseniaOutputStatusRaw): void {
        if (status === null || typeof status !== 'object') return;
        const outputId = String(status.ID);
        this.rememberState(outputId, status);
        const pending = this.pending.get(outputId);
        const matches = pending !== undefined && safeMatches(pending.matches, status);
        if (this.claimedByEarlierCommand(outputId, status)) {
            if (pending && !matches) pending.armed = true;
            return;
        }
        if (!pending) return;
        if (!matches) {
            pending.armed = true;
            return;
        }
        if (!pending.armed) return;

        clearTimeout(pending.timeout);
        this.pending.delete(outputId);
        pending.outcome = 'confirmed';
        pending.resolve({
            status: 'state-confirmed',
            latencyMs: Date.now() - pending.startedAt,
        });
    }

    public rejectAll(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.outcome = 'released';
            pending.reject(error);
        }
        this.pending.clear();
        this.owed.clear();
    }

    /**
     * Attributes `status` to the oldest earlier command still owed an event that
     * it satisfies; that command and any older one are then settled. An event
     * that matches none of them is new information.
     */
    private claimedByEarlierCommand(outputId: string, status: KseniaOutputStatusRaw): boolean {
        const list = this.owed.get(outputId);
        if (!list) return false;
        const now = Date.now();
        const live = list.filter((owed) => owed.expiresAt > now);
        const index = live.findIndex((owed) => safeMatches(owed.matches, status));
        const remaining = index < 0 ? live : live.slice(index + 1);
        if (remaining.length > 0) this.owed.set(outputId, remaining);
        else this.owed.delete(outputId);
        return index >= 0;
    }

    private rememberState(outputId: string, status: KseniaOutputStatusRaw): void {
        this.lastState.delete(outputId);
        this.lastState.set(outputId, status);
        if (this.lastState.size > OutputCommandConfirmationTracker.LAST_STATE_LIMIT) {
            const oldest = this.lastState.keys().next().value;
            if (oldest !== undefined) this.lastState.delete(oldest);
        }
    }
}

/** A matcher that throws on a malformed status is a non-match, not a lost frame. */
function safeMatches(matches: (status: KseniaOutputStatusRaw) => boolean, status: KseniaOutputStatusRaw): boolean {
    try {
        return matches(status);
    } catch {
        return false;
    }
}
