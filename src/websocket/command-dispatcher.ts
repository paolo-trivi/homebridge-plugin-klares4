import { RetryableKlaresError } from '../errors';

interface PendingCommandRequest {
    commandId: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    expectedCmds?: Set<string>;
}

export interface ResponseLikeMessage {
    ID: string;
    CMD: string;
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
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout((): void => {
                this.pendingCommands.delete(commandId);
                reject(new RetryableKlaresError(`Command ${commandId} timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingCommands.set(commandId, {
                commandId,
                timeout,
                resolve: (): void => {
                    clearTimeout(timeout);
                    this.pendingCommands.delete(commandId);
                    resolve();
                },
                reject: (error: Error): void => {
                    clearTimeout(timeout);
                    this.pendingCommands.delete(commandId);
                    reject(error);
                },
                expectedCmds:
                    responseCmds && responseCmds.length > 0 ? new Set(responseCmds) : undefined,
            });
        });
    }

    public resolvePendingCommand(message: ResponseLikeMessage): void {
        const pendingCommand = this.pendingCommands.get(message.ID);
        if (pendingCommand) {
            if (pendingCommand.expectedCmds && !pendingCommand.expectedCmds.has(message.CMD)) {
                return;
            }
            pendingCommand.resolve();
            return;
        }

        // Some panel firmwares can answer with a response ID different from the request ID.
        // When there is exactly one compatible pending command, resolve it as fallback.
        const compatiblePending: PendingCommandRequest[] = [];
        for (const candidate of this.pendingCommands.values()) {
            if (candidate.expectedCmds && !candidate.expectedCmds.has(message.CMD)) {
                continue;
            }
            compatiblePending.push(candidate);
        }

        if (compatiblePending.length === 1) {
            compatiblePending[0].resolve();
        }
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
}
