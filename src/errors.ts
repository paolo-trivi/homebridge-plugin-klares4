export type ErrorCategory = 'retryable' | 'validation' | 'fatal';

export class KlaresError extends Error {
    constructor(
        message: string,
        public readonly category: ErrorCategory,
    ) {
        super(message);
        this.name = 'KlaresError';
    }
}

export class RetryableKlaresError extends KlaresError {
    constructor(message: string) {
        super(message, 'retryable');
        this.name = 'RetryableKlaresError';
    }
}

export class ValidationKlaresError extends KlaresError {
    constructor(message: string) {
        super(message, 'validation');
        this.name = 'ValidationKlaresError';
    }
}

export class PanelCommandRejectedError extends KlaresError {
    constructor(
        public readonly result: string,
        public readonly detail?: string,
    ) {
        super(
            `Panel rejected command: ${result}${detail ? ` (${detail})` : ''}`,
            'validation',
        );
        this.name = 'PanelCommandRejectedError';
    }
}

export class FatalKlaresError extends KlaresError {
    constructor(message: string) {
        super(message, 'fatal');
        this.name = 'FatalKlaresError';
    }
}

export function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
