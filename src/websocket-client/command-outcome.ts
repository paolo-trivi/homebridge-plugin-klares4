import type { Logger } from 'homebridge';
import type { KseniaOutputStatusRaw } from '../types';
import type { CommandAcknowledgement } from '../websocket/command-dispatcher';
import type { StateConfirmation } from '../websocket/output-command-confirmation';
import type { SendCommandOptions } from './types';

export type MutationOutcome = CommandAcknowledgement | StateConfirmation | undefined;

export function mutationOptions(
    outputId?: string,
    matches?: (status: KseniaOutputStatusRaw) => boolean,
): SendCommandOptions {
    return {
        awaitResponse: true,
        responseCmds: ['CMD_USR_RES'],
        requirePositiveResult: true,
        allowGenericErrorFallback: true,
        ...(outputId && matches ? { stateConfirmation: { outputId, matches } } : {}),
    };
}

/**
 * Logs a confirmed mutation. A command that went out with nothing confirming
 * it is a failure (a socket write is not a success), so it throws.
 */
export function reportMutationOutcome(
    log: Logger,
    kind: string,
    id: string,
    target: string,
    outcome: MutationOutcome,
): void {
    if (!outcome) {
        throw new Error(`${kind} command sent without confirmation: ${id} -> ${target}`);
    }
    log.info(`${kind} command ${outcome.status}: ${id} -> ${target} (${outcome.latencyMs}ms)`);
}
