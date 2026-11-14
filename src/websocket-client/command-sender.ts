import WebSocket from 'ws';
import type { Logger } from 'homebridge';
import { LogLevel, maskSensitiveData } from '../log-levels';
import type { CommandAcknowledgement, CommandDispatcher } from '../websocket/command-dispatcher';
import type {
    OutputCommandConfirmationTracker,
    OutputConfirmationHandle,
    StateConfirmation,
} from '../websocket/output-command-confirmation';
import type { WsTransport } from '../websocket/ws-transport';
import type { KseniaMessage, KseniaMessagePayload, KseniaWebSocketOptions } from '../types';
import type { KseniaCommandPayload, RawMessageDirection, SendCommandOptions, WebSocketClientState } from './types';
import { calculateCRC16 } from './crc16';
import { PanelCommandRejectedError } from '../errors';

/** Commands that change something on the panel: only an explicit RESULT=OK acknowledges them. */
const MUTATING_COMMANDS: ReadonlySet<string> = new Set(['CMD_USR', 'WRITE_CFG']);

export interface CommandSenderDeps {
    state: WebSocketClientState;
    sender: string;
    pin: string;
    log: Logger;
    logLevel: LogLevel;
    options: KseniaWebSocketOptions;
    commandDispatcher: CommandDispatcher;
    outputConfirmation?: OutputCommandConfirmationTracker;
    wsTransport: WsTransport;
    emitRawMessage: (direction: RawMessageDirection, rawMessage: string) => void;
}

/**
 * Frames and sends one command: ID allocation, `ID_LOGIN`/`PIN` substitution,
 * CRC, then the wait for the panel's answer (response and/or state
 * confirmation) as requested by the caller.
 */
export class CommandSender {
    constructor(private readonly deps: CommandSenderDeps) {}

    public async send(
        cmd: string,
        payloadType: string,
        payload: KseniaCommandPayload,
        requestedOptions: SendCommandOptions = {},
    ): Promise<CommandAcknowledgement | StateConfirmation | undefined> {
        const options: SendCommandOptions = MUTATING_COMMANDS.has(cmd)
            ? { ...requestedOptions, awaitResponse: true, requirePositiveResult: true }
            : requestedOptions;
        if (!this.deps.state.ws || this.deps.state.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected');
        }
        const processedPayload = this.buildPayload(payload);
        const id = this.createCommandId();
        const message: KseniaMessage = {
            SENDER: this.deps.sender,
            RECEIVER: '',
            CMD: cmd,
            ID: id,
            PAYLOAD_TYPE: payloadType,
            PAYLOAD: processedPayload as KseniaMessagePayload,
            TIMESTAMP: Math.floor(Date.now() / 1000).toString(),
            CRC_16: '0x0000',
        };
        message.CRC_16 = calculateCRC16(JSON.stringify(message));
        const jsonMessage = JSON.stringify(message);
        const isPing = cmd === 'PING' || payloadType === 'HEARTBEAT';
        if (!isPing && this.deps.logLevel >= LogLevel.DEBUG) {
            this.deps.log.debug(`Sending: ${maskSensitiveData(jsonMessage)}`);
        }
        let pendingResponsePromise: Promise<CommandAcknowledgement> | undefined;
        let stateConfirmation: OutputConfirmationHandle | undefined;
        let written = false;
        // Both registrations sit inside the try so the finally always clears
        // them, and each promise gets a no-op handler at creation: it can be
        // rejected (timeout, disconnect) before or without being awaited, and
        // Homebridge turns an unhandled rejection into a bridge restart.
        try {
            if (options.awaitResponse) {
                pendingResponsePromise = this.deps.commandDispatcher.registerPendingCommand(
                    id,
                    options.timeoutMs ?? this.deps.options.commandTimeoutMs ?? 8000,
                    options.responseCmds,
                    options.requirePositiveResult,
                    options.allowGenericErrorFallback,
                    options.responsePayloadTypes,
                );
                pendingResponsePromise.catch((): void => undefined);
            } else {
                this.deps.commandDispatcher.noteFireAndForget(id);
            }
            if (options.stateConfirmation) {
                if (!this.deps.outputConfirmation) {
                    throw new Error('Output confirmation tracker not initialized');
                }
                stateConfirmation = this.deps.outputConfirmation.register(
                    options.stateConfirmation.outputId,
                    options.timeoutMs ?? this.deps.options.commandTimeoutMs ?? 8000,
                    options.stateConfirmation.matches,
                );
                stateConfirmation.promise.catch((): void => undefined);
            }
            await this.sendRaw(jsonMessage);
            written = true;
            const outcome = pendingResponsePromise && stateConfirmation
                ? await Promise.race([pendingResponsePromise, stateConfirmation.promise])
                : await (pendingResponsePromise ?? stateConfirmation?.promise);
            if (outcome?.status === 'acknowledged') stateConfirmation?.expectLateState();
            return outcome;
        } catch (error) {
            // A refused command changes nothing; any other failure (timeout) may
            // still have been executed, and its realtime event may follow.
            if (!written || error instanceof PanelCommandRejectedError) stateConfirmation?.cancel();
            else stateConfirmation?.expectLateState();
            throw error;
        } finally {
            this.deps.commandDispatcher.clearPendingCommand(id);
            stateConfirmation?.cancel();
        }
    }

    private createCommandId(): string {
        // 16-bit IDs: the panel echoes the ID modulo 65536 (86152 comes back as
        // 20616), so a larger ID could never be correlated exactly.
        for (let attempt = 0; attempt < 1000; attempt += 1) {
            const candidate = (1 + Math.floor(Math.random() * 65535)).toString();
            if (!this.deps.commandDispatcher.isKnownCommandId(candidate)) return candidate;
        }
        throw new Error('Unable to allocate a unique command ID');
    }

    private buildPayload(payload: KseniaCommandPayload): KseniaCommandPayload {
        return {
            ...payload,
            ...(payload?.ID_LOGIN === 'true' && { ID_LOGIN: this.deps.state.idLogin }),
            ...(payload?.PIN === 'true' && { PIN: this.deps.pin }),
        };
    }

    public async sendRaw(rawMessage: string): Promise<void> {
        this.deps.emitRawMessage('out', rawMessage);
        await this.deps.wsTransport.send(this.deps.state.ws, rawMessage);
    }
}
