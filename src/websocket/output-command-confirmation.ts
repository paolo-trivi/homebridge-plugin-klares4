import { RetryableKlaresError } from '../errors';
import type { KseniaOutputStatusRaw } from '../types';

export interface StateConfirmation {
    status: 'state-confirmed';
    latencyMs: number;
}

export interface OutputConfirmationHandle {
    promise: Promise<StateConfirmation>;
    cancel: () => void;
}

interface PendingOutputConfirmation {
    startedAt: number;
    matches: (status: KseniaOutputStatusRaw) => boolean;
    resolve: (confirmation: StateConfirmation) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

export class OutputCommandConfirmationTracker {
    private readonly pending = new Map<string, PendingOutputConfirmation>();

    public register(
        outputId: string,
        timeoutMs: number,
        matches: (status: KseniaOutputStatusRaw) => boolean,
    ): OutputConfirmationHandle {
        if (this.pending.has(outputId)) {
            throw new Error(`Output ${outputId} already has a pending state confirmation`);
        }

        let cancel = (): void => undefined;
        const promise = new Promise<StateConfirmation>((resolve, reject) => {
            const timeout = setTimeout((): void => {
                this.pending.delete(outputId);
                reject(new RetryableKlaresError(
                    `Output ${outputId} state confirmation timed out after ${timeoutMs}ms`,
                ));
            }, timeoutMs);

            this.pending.set(outputId, {
                startedAt: Date.now(),
                matches,
                resolve,
                reject,
                timeout,
            });
            cancel = (): void => {
                const current = this.pending.get(outputId);
                if (!current || current.timeout !== timeout) return;
                clearTimeout(timeout);
                this.pending.delete(outputId);
            };
        });

        return { promise, cancel };
    }

    public observe(status: KseniaOutputStatusRaw): void {
        const pending = this.pending.get(status.ID);
        if (!pending || !pending.matches(status)) return;

        clearTimeout(pending.timeout);
        this.pending.delete(status.ID);
        pending.resolve({
            status: 'state-confirmed',
            latencyMs: Date.now() - pending.startedAt,
        });
    }

    public rejectAll(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
    }
}
