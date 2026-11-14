import { PanelCommandRejectedError, RetryableKlaresError } from '../errors';
import { DeviceCommandQueue, type DeviceQueueOptions } from './device-command-queue';

export { CommandQueueRejectedError } from './device-command-queue';
export type { CommandQueueRejection, DeviceQueueOptions, DeviceQueuePolicy } from './device-command-queue';

export interface CommandAcknowledgement {
    status: 'acknowledged';
    responseCmd: string;
    correlation: 'exact-id' | 'single-compatible';
    latencyMs: number;
}

interface PendingCommandRequest {
    commandId: string;
    resolve: (acknowledgement: CommandAcknowledgement) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    expectedCmds?: Set<string>;
    requirePositiveResult: boolean;
    allowGenericErrorFallback: boolean;
    /** When set, a response without an exact ID must carry one of these PAYLOAD_TYPEs. */
    fallbackPayloadTypes?: Set<string>;
    registeredAt: number;
}

export interface ResponseLikeMessage {
    /** Some firmwares echo the ID as a JSON number. */
    ID: string | number;
    CMD: string;
    PAYLOAD_TYPE?: string;
    PAYLOAD?: {
        RESULT?: unknown;
        RESULT_DETAIL?: unknown;
    };
}

/** A malformed RESULT (number, object) is no result, never a crash. */
function normalizedText(value: unknown): string | undefined {
    return typeof value === 'string' ? value.trim() : undefined;
}

export class CommandDispatcher {
    private static readonly RETIRED_ID_LIMIT = 256;
    private readonly commandQueue = new DeviceCommandQueue();
    private readonly pendingCommands: Map<string, PendingCommandRequest> = new Map();
    /** IDs of commands that already finished (settled, timed out or cleared), oldest first. */
    private readonly retiredCommandIds: Set<string> = new Set();

    /**
     * Runs `command` when no other command for `key` is running, following
     * `options` (see `DeviceQueueOptions`). Without options: serial, no deadline,
     * depth capped at `DeviceCommandQueue.DEFAULT_MAX_DEPTH`.
     */
    public enqueueDeviceCommand(
        key: string,
        command: () => Promise<void>,
        options?: DeviceQueueOptions,
    ): Promise<void> {
        return this.commandQueue.enqueue(key, command, options);
    }

    /** Commands queued or running for `key`. */
    public queuedCommandCount(key: string): number {
        return this.commandQueue.size(key);
    }

    public registerPendingCommand(
        commandId: string,
        timeoutMs: number,
        responseCmds?: string[],
        requirePositiveResult = false,
        allowGenericErrorFallback = false,
        fallbackPayloadTypes?: string[],
    ): Promise<CommandAcknowledgement> {
        if (this.pendingCommands.has(commandId)) {
            return Promise.reject(new Error(`Command ID ${commandId} is already pending`));
        }
        this.retiredCommandIds.delete(commandId);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout((): void => {
                this.pendingCommands.delete(commandId);
                this.retire(commandId);
                reject(new RetryableKlaresError(`Command ${commandId} timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingCommands.set(commandId, {
                commandId,
                timeout,
                resolve: (acknowledgement): void => {
                    clearTimeout(timeout);
                    this.pendingCommands.delete(commandId);
                    this.retire(commandId);
                    resolve(acknowledgement);
                },
                reject: (error: Error): void => {
                    clearTimeout(timeout);
                    this.pendingCommands.delete(commandId);
                    this.retire(commandId);
                    reject(error);
                },
                expectedCmds:
                    responseCmds && responseCmds.length > 0 ? new Set(responseCmds) : undefined,
                requirePositiveResult,
                allowGenericErrorFallback,
                fallbackPayloadTypes: fallbackPayloadTypes && fallbackPayloadTypes.length > 0
                    ? new Set(fallbackPayloadTypes.map((type) => type.toUpperCase()))
                    : undefined,
                registeredAt: Date.now(),
            });
        });
    }

    public resolvePendingCommand(message: ResponseLikeMessage): void {
        const messageId = String(message.ID);
        const pendingCommand = this.pendingCommands.get(messageId);
        if (pendingCommand) {
            if (!this.isCompatible(pendingCommand, message, true)) {
                return;
            }
            this.settle(pendingCommand, message, 'exact-id');
            return;
        }

        // A late or duplicate response for a command that already finished must
        // not be re-attributed to whichever other command happens to be pending.
        if (this.retiredCommandIds.has(messageId)) {
            return;
        }

        // Some panel firmwares can answer with a response ID different from the request ID.
        // When there is exactly one compatible pending command, resolve it as fallback.
        const compatiblePending: PendingCommandRequest[] = [];
        for (const candidate of this.pendingCommands.values()) {
            if (this.isCompatible(candidate, message, false)) compatiblePending.push(candidate);
        }

        if (compatiblePending.length === 1) {
            this.settle(compatiblePending[0], message, 'single-compatible');
        }
    }

    public hasPendingCommand(commandId: string): boolean {
        return this.pendingCommands.has(commandId);
    }

    /** Pending or recently finished: a new command must not reuse the ID. */
    public isKnownCommandId(commandId: string): boolean {
        return this.pendingCommands.has(commandId) || this.retiredCommandIds.has(commandId);
    }

    /**
     * A command sent without awaiting its response (login data reads, realtime
     * register). Its ID is remembered with the finished ones so its response is
     * recognised and ignored instead of being handed to another pending command.
     */
    public noteFireAndForget(commandId: string): void {
        if (!this.pendingCommands.has(commandId)) this.retire(commandId);
    }

    public clearPendingCommand(commandId: string): void {
        const pendingCommand = this.pendingCommands.get(commandId);
        if (!pendingCommand) {
            return;
        }

        clearTimeout(pendingCommand.timeout);
        this.pendingCommands.delete(commandId);
        this.retire(commandId);
    }

    /** The socket is gone: pending commands fail, and queued ones are never sent on the next socket. */
    public rejectAllPendingCommands(error: Error): void {
        this.commandQueue.rejectWaiting(error);
        for (const pendingCommand of this.pendingCommands.values()) {
            pendingCommand.reject(error);
        }
        this.pendingCommands.clear();
    }

    public clearCommandQueues(): void {
        this.commandQueue.rejectWaiting(new RetryableKlaresError('Command queue cleared: client disconnected'));
    }

    private retire(commandId: string): void {
        this.retiredCommandIds.delete(commandId);
        this.retiredCommandIds.add(commandId);
        if (this.retiredCommandIds.size > CommandDispatcher.RETIRED_ID_LIMIT) {
            const oldest = this.retiredCommandIds.values().next().value;
            if (oldest !== undefined) this.retiredCommandIds.delete(oldest);
        }
    }

    private isCompatible(
        pending: PendingCommandRequest,
        message: ResponseLikeMessage,
        exactId: boolean,
    ): boolean {
        if (!exactId && !this.matchesFallbackPayloadType(pending, message)) return false;
        if (!pending.expectedCmds || pending.expectedCmds.has(message.CMD)) return true;
        if (!this.isExplicitFailure(message)) return false;
        if (exactId) return true;
        // Without an exact ID, a typed response (READ_RES, WRITE_CFG_RES, ...) only
        // answers its own command type: the READ_RES FAIL the panel sends for
        // PRG_THERMOSTATS at every login must not reject a pending CMD_USR. Only an
        // untyped error (GENERIC, PAYLOAD_TYPE ERROR) may stand in for the response.
        return pending.allowGenericErrorFallback && !message.CMD.toUpperCase().endsWith('_RES');
    }

    private matchesFallbackPayloadType(pending: PendingCommandRequest, message: ResponseLikeMessage): boolean {
        if (!pending.fallbackPayloadTypes) return true;
        const payloadType = message.PAYLOAD_TYPE?.toUpperCase();
        return payloadType !== undefined && pending.fallbackPayloadTypes.has(payloadType);
    }

    private isExplicitFailure(message: ResponseLikeMessage): boolean {
        const result = normalizedText(message.PAYLOAD?.RESULT)?.toUpperCase();
        return message.PAYLOAD_TYPE?.toUpperCase() === 'ERROR'
            || message.CMD.toUpperCase() === 'GENERIC'
            || (result !== undefined && result !== 'OK');
    }

    private settle(
        pending: PendingCommandRequest,
        message: ResponseLikeMessage,
        correlation: CommandAcknowledgement['correlation'],
    ): void {
        const result = normalizedText(message.PAYLOAD?.RESULT)?.toUpperCase();
        const detail = normalizedText(message.PAYLOAD?.RESULT_DETAIL);
        if (this.isExplicitFailure(message)) {
            pending.reject(new PanelCommandRejectedError(result ?? 'FAIL', detail));
            return;
        }
        if (pending.requirePositiveResult && result !== 'OK') {
            pending.reject(new RetryableKlaresError(
                `Command ${pending.commandId} response ${message.CMD} did not contain RESULT=OK`,
            ));
            return;
        }
        pending.resolve({
            status: 'acknowledged',
            responseCmd: message.CMD,
            correlation,
            latencyMs: Date.now() - pending.registeredAt,
        });
    }
}
