import { PanelCommandRejectedError, RetryableKlaresError } from '../errors';

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
    registeredAt: number;
}

export interface ResponseLikeMessage {
    ID: string;
    CMD: string;
    PAYLOAD_TYPE?: string;
    PAYLOAD?: {
        RESULT?: string;
        RESULT_DETAIL?: string;
    };
}

export class CommandDispatcher {
    private readonly commandQueues: Map<string, Promise<void>> = new Map();
    private readonly pendingCommands: Map<string, PendingCommandRequest> = new Map();

    public enqueueDeviceCommand(deviceId: string, command: () => Promise<void>): Promise<void> {
        const previous = this.commandQueues.get(deviceId) ?? Promise.resolve();
        const current = previous
            .catch((): void => undefined)
            .then(command)
            .finally((): void => {
                if (this.commandQueues.get(deviceId) === current) {
                    this.commandQueues.delete(deviceId);
                }
            });

        this.commandQueues.set(deviceId, current);
        return current;
    }

    public registerPendingCommand(
        commandId: string,
        timeoutMs: number,
        responseCmds?: string[],
        requirePositiveResult = false,
        allowGenericErrorFallback = false,
    ): Promise<CommandAcknowledgement> {
        if (this.pendingCommands.has(commandId)) {
            return Promise.reject(new Error(`Command ID ${commandId} is already pending`));
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout((): void => {
                this.pendingCommands.delete(commandId);
                reject(new RetryableKlaresError(`Command ${commandId} timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingCommands.set(commandId, {
                commandId,
                timeout,
                resolve: (acknowledgement): void => {
                    clearTimeout(timeout);
                    this.pendingCommands.delete(commandId);
                    resolve(acknowledgement);
                },
                reject: (error: Error): void => {
                    clearTimeout(timeout);
                    this.pendingCommands.delete(commandId);
                    reject(error);
                },
                expectedCmds:
                    responseCmds && responseCmds.length > 0 ? new Set(responseCmds) : undefined,
                requirePositiveResult,
                allowGenericErrorFallback,
                registeredAt: Date.now(),
            });
        });
    }

    public resolvePendingCommand(message: ResponseLikeMessage): void {
        const pendingCommand = this.pendingCommands.get(message.ID);
        if (pendingCommand) {
            if (!this.isCompatible(pendingCommand, message, true)) {
                return;
            }
            this.settle(pendingCommand, message, 'exact-id');
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

    public clearPendingCommand(commandId: string): void {
        const pendingCommand = this.pendingCommands.get(commandId);
        if (!pendingCommand) {
            return;
        }

        clearTimeout(pendingCommand.timeout);
        this.pendingCommands.delete(commandId);
    }

    public rejectAllPendingCommands(error: Error): void {
        for (const pendingCommand of this.pendingCommands.values()) {
            pendingCommand.reject(error);
        }
        this.pendingCommands.clear();
    }

    public clearCommandQueues(): void {
        this.commandQueues.clear();
    }

    private isCompatible(
        pending: PendingCommandRequest,
        message: ResponseLikeMessage,
        exactId: boolean,
    ): boolean {
        if (!pending.expectedCmds || pending.expectedCmds.has(message.CMD)) return true;
        if (!this.isExplicitFailure(message)) return false;
        return exactId || pending.allowGenericErrorFallback;
    }

    private isExplicitFailure(message: ResponseLikeMessage): boolean {
        const result = message.PAYLOAD?.RESULT?.trim().toUpperCase();
        return message.PAYLOAD_TYPE?.toUpperCase() === 'ERROR'
            || message.CMD.toUpperCase() === 'GENERIC'
            || (result !== undefined && result !== 'OK');
    }

    private settle(
        pending: PendingCommandRequest,
        message: ResponseLikeMessage,
        correlation: CommandAcknowledgement['correlation'],
    ): void {
        const result = message.PAYLOAD?.RESULT?.trim().toUpperCase();
        const detail = message.PAYLOAD?.RESULT_DETAIL?.trim();
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
