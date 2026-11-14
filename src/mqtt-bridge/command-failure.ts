import type { Logger } from 'homebridge';

import { toErrorMessage } from '../errors';

/** Why the panel command queue turned a command down (`CommandQueueRejectedError.reason`). */
const QUEUE_REJECTIONS: Record<string, string> = {
    busy: 'the device is still executing the previous command',
    superseded: 'a newer command for the same device replaced it',
    expired: 'it waited in the queue longer than commandTimeoutMs',
    'queue-full': 'too many commands are waiting for this device',
};

/** Expected refusals: the command was not acceptable or not sent, nothing is broken. */
const REFUSALS = new Set(['CommandQueueRejectedError', 'ValidationKlaresError']);

function reasonOf(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('reason' in error)) return undefined;
    return typeof error.reason === 'string' ? error.reason : undefined;
}

/**
 * Logs a command that did not go through. A refusal (queue rejection,
 * validation: unknown device, value out of range, arming scenario) is a
 * `warn` saying why; anything else is an `error`. The error classes are
 * recognised by name so this module needs none of them.
 */
export function logCommandFailure(log: Logger, what: string, error: unknown): void {
    const reason = reasonOf(error);
    const name = error instanceof Error ? error.name : '';
    if (reason !== undefined || REFUSALS.has(name)) {
        const why = reason !== undefined ? QUEUE_REJECTIONS[reason] ?? reason : toErrorMessage(error);
        log.warn(`MQTT: ${what} not executed: ${why}`);
        return;
    }
    if (name === 'HapStatusError') {
        // The accessory has already logged the cause; it reports only a HAP status.
        log.warn(`MQTT: ${what} failed (see the accessory error above)`);
        return;
    }
    log.error(`MQTT: ${what} error:`, toErrorMessage(error));
}
