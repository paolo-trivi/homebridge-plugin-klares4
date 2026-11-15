/**
 * The plugin's error types. A caller tells them apart with `instanceof`:
 * - `RetryableKlaresError`: the command did not complete (timeout, lost
 *   connection, queue refusal); the same command may work later.
 * - `ValidationKlaresError`: the command was refused before anything was
 *   sent (value not acceptable, device unknown or not exposed, routing that
 *   cannot be established). Nothing is broken; retrying it unchanged is useless.
 * - `PanelCommandRejectedError`: the panel answered, with a refusal.
 */
export class KlaresError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KlaresError';
    }
}

export class RetryableKlaresError extends KlaresError {
    constructor(message: string) {
        super(message);
        this.name = 'RetryableKlaresError';
    }
}

export class ValidationKlaresError extends KlaresError {
    constructor(message: string) {
        super(message);
        this.name = 'ValidationKlaresError';
    }
}

export class PanelCommandRejectedError extends KlaresError {
    constructor(
        public readonly result: string,
        public readonly detail?: string,
    ) {
        super(`Panel rejected command: ${result}${detail ? ` (${detail})` : ''}`);
        this.name = 'PanelCommandRejectedError';
    }
}

/**
 * The text of anything thrown. An `AggregateError` (a connection attempt on
 * several addresses, `Promise.any`) often has an empty message of its own:
 * the messages of the errors it groups are what explains it.
 */
export function toErrorMessage(error: unknown): string {
    if (error instanceof AggregateError) {
        const parts = [error.message, ...error.errors.map(toErrorMessage)].filter((part) => part !== '');
        return [...new Set(parts)].join('; ') || error.name;
    }
    if (error instanceof Error) return error.message || error.name;
    return String(error);
}
