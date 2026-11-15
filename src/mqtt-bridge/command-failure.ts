import type { Logger } from 'homebridge';

import { toErrorMessage, ValidationKlaresError } from '../errors';

/** Why the panel command queue turned a command down (`CommandQueueRejectedError.reason`). */
const QUEUE_REJECTIONS: Record<string, string> = {
    busy: 'the device is still executing the previous command',
    superseded: 'a newer command for the same device replaced it',
    expired: 'it waited in the queue longer than commandTimeoutMs',
    'queue-full': 'too many commands are waiting for this device',
};

/** HAP handlers throw a `HapStatusError` (it has `hapStatus`) carrying the real error as `cause`. */
function isHapStatusError(error: unknown): error is Error & { cause?: unknown } {
    return error instanceof Error && 'hapStatus' in error;
}

function reasonOf(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('reason' in error)) return undefined;
    return typeof error.reason === 'string' ? error.reason : undefined;
}

/**
 * Logs a command that did not go through. A refusal (queue rejection,
 * validation: unknown device, value out of range, arming scenario) is a
 * `warn` saying why; anything else is an `error`. A queue rejection is
 * recognised by its `reason`, a validation refusal by its class. A failure
 * reported by a HAP handler is judged by the error it carries as `cause`.
 */
export function logCommandFailure(log: Logger, what: string, thrown: unknown): void {
    if (isHapStatusError(thrown) && thrown.cause === undefined) {
        // The accessory has already logged the cause; it reports only a HAP status.
        log.warn(`MQTT: ${what} failed (see the accessory error above)`);
        return;
    }
    const error = isHapStatusError(thrown) ? thrown.cause : thrown;
    const reason = reasonOf(error);
    if (reason !== undefined || error instanceof ValidationKlaresError) {
        const why = reason !== undefined ? QUEUE_REJECTIONS[reason] ?? reason : toErrorMessage(error);
        log.warn(`MQTT: ${what} not executed: ${why}`);
        return;
    }
    log.error(`MQTT: ${what} error:`, toErrorMessage(error));
}
