import WebSocket from 'ws';
import type { Logger } from 'homebridge';
import { LogLevel, maskSensitiveData } from '../log-levels';
import { stripDevicePrefix } from '../device-id';
import type { ThermostatMode } from '../thermostat-mode';
import { CommandDispatcher } from '../websocket/command-dispatcher';
import { clampValue } from '../websocket/device-state-projector';
import { WsTransport } from '../websocket/ws-transport';
import { updateThermostatSeasonHint } from './thermostat-write-payload';
import { buildThermostatModeCommandPayload, buildThermostatSetpointCommandPayload } from './thermostat-command-payload';
import { resolveThermostatCommandId } from './thermostat-command-id-resolver';
import type { KseniaMessage, KseniaMessagePayload, KseniaWebSocketOptions } from '../types';
import type { KseniaCommandPayload, RawMessageDirection, SendCommandOptions, WebSocketClientState } from './types';
import { calculateCRC16 } from './crc16';
interface CommandServiceDeps {
    state: WebSocketClientState;
    sender: string;
    pin: string;
    log: Logger;
    logLevel: LogLevel;
    options: KseniaWebSocketOptions;
    commandDispatcher: CommandDispatcher;
    wsTransport: WsTransport;
    emitRawMessage: (direction: RawMessageDirection, rawMessage: string) => void;
} export class CommandService {
    constructor(private readonly deps: CommandServiceDeps) {}
    private readonly thermostatWriteSeasonById: Map<string, 'WIN' | 'SUM'> = new Map();
    private static readonly THERMOSTAT_ACK_TIMEOUT_MS = 2500;
    public async sendLoginCommand(): Promise<void> {
        const loginMessage: KseniaMessage = {
            SENDER: this.deps.sender,
            RECEIVER: '',
            CMD: 'LOGIN',
            ID: Math.floor(Math.random() * 65535).toString(),
            PAYLOAD_TYPE: 'UNKNOWN',
            PAYLOAD: {
                PIN: this.deps.pin,
            },
            TIMESTAMP: Math.floor(Date.now() / 1000).toString(),
            CRC_16: '0x0000',
        };
        loginMessage.CRC_16 = calculateCRC16(JSON.stringify(loginMessage));
        this.deps.log.info('Executing login...');
        const messageStr = JSON.stringify(loginMessage);
        this.deps.log.info(`Sending: ${maskSensitiveData(messageStr)}`);
        await this.sendRawMessage(messageStr);
    }
    public async requestSystemData(): Promise<void> {
        if (!this.deps.state.idLogin) {
            this.deps.log.error('ID_LOGIN not available');
            return;
        }
        await this.sendKseniaCommand('READ', 'ZONES', { ID_LOGIN: this.deps.state.idLogin, ID_ITEMS_RANGE: ['ALL', 'ALL'] });
        await this.sendKseniaCommand('READ', 'MULTI_TYPES', { ID_LOGIN: this.deps.state.idLogin, TYPES: ['OUTPUTS', 'BUS_HAS', 'SCENARIOS'] });
        await this.sendKseniaCommand('READ', 'STATUS_OUTPUTS', { ID_LOGIN: this.deps.state.idLogin });
        await this.sendKseniaCommand('READ', 'STATUS_BUS_HA_SENSORS', { ID_LOGIN: this.deps.state.idLogin });
        await this.sendKseniaCommand('READ', 'STATUS_SYSTEM', { ID_LOGIN: this.deps.state.idLogin });
        await this.sendKseniaCommand('READ', 'PRG_THERMOSTATS', { ID_LOGIN: this.deps.state.idLogin, ID_READ: 'ALL', ID_ITEMS_RANGE: ['ALL', 'ALL'] });
        await this.sendKseniaCommand('READ', 'CFG_THERMOSTATS', { ID_LOGIN: this.deps.state.idLogin, ID_READ: 'ALL', ID_ITEMS_RANGE: ['ALL', 'ALL'] });
        await this.sendKseniaCommand('REALTIME', 'REGISTER', {
            ID_LOGIN: this.deps.state.idLogin,
            TYPES: [
                'STATUS_ZONES',
                'STATUS_OUTPUTS',
                'STATUS_BUS_HA_SENSORS',
                'STATUS_SYSTEM',
                'STATUS_TEMPERATURES',
                'SCENARIOS',
            ],
        });
    }
    public async switchLight(lightId: string, on: boolean): Promise<void> {
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const systemOutputId = stripDevicePrefix(lightId);
        await this.deps.commandDispatcher.enqueueDeviceCommand(lightId, async (): Promise<void> => {
            await this.sendKseniaCommand('CMD_USR', 'CMD_SET_OUTPUT', {
                ID_LOGIN: 'true',
                PIN: 'true',
                OUTPUT: {
                    ID: systemOutputId,
                    STA: on ? 'ON' : 'OFF',
                },
            });
        });
        this.deps.log.info(`Light command sent: Output ${systemOutputId} -> ${on ? 'ON' : 'OFF'}`);
    }
    public async dimLight(lightId: string, brightness: number): Promise<void> {
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const safeBrightness = clampValue(Math.round(brightness), 0, 100);
        const systemOutputId = stripDevicePrefix(lightId);
        await this.deps.commandDispatcher.enqueueDeviceCommand(lightId, async (): Promise<void> => {
            await this.sendKseniaCommand('CMD_USR', 'CMD_SET_OUTPUT', {
                ID_LOGIN: 'true',
                PIN: 'true',
                OUTPUT: {
                    ID: systemOutputId,
                    STA: safeBrightness.toString(),
                },
            });
        });
        this.deps.log.info(`Dimmer command sent: Output ${systemOutputId} -> ${safeBrightness}%`);
    }
    public async moveCover(coverId: string, position: number): Promise<void> {
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const systemOutputId = stripDevicePrefix(coverId);
        const safePosition = clampValue(Math.round(position), 0, 100);
        const command = safePosition === 0 ? 'DOWN' : safePosition === 100 ? 'UP' : safePosition.toString();
        await this.deps.commandDispatcher.enqueueDeviceCommand(coverId, async (): Promise<void> => {
            await this.sendKseniaCommand('CMD_USR', 'CMD_SET_OUTPUT', {
                ID_LOGIN: 'true',
                PIN: 'true',
                OUTPUT: {
                    ID: systemOutputId,
                    STA: command,
                },
            });
        });
        this.deps.log.info(`Cover command sent: Output ${systemOutputId} -> ${command}`);
    }
    public async toggleGate(gateId: string): Promise<void> {
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const systemOutputId = stripDevicePrefix(gateId);
        await this.deps.commandDispatcher.enqueueDeviceCommand(gateId, async (): Promise<void> => {
            await this.sendKseniaCommand('CMD_USR', 'CMD_SET_OUTPUT', {
                ID_LOGIN: 'true',
                PIN: 'true',
                OUTPUT: {
                    ID: systemOutputId,
                    STA: 'ON',
                },
            });
        });
        this.deps.log.info(`Gate command sent: Output ${systemOutputId} -> ON (momentary)`);
    }
    public async setThermostatMode(thermostatId: string, mode: ThermostatMode): Promise<void> {
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const outputThermostatId = stripDevicePrefix(thermostatId);
        const commandThermostatId = await this.resolveThermostatCommandId(outputThermostatId);
        updateThermostatSeasonHint(this.thermostatWriteSeasonById, commandThermostatId, mode);
        await this.deps.commandDispatcher.enqueueDeviceCommand(thermostatId, async (): Promise<void> => {
            const cfgEntry = buildThermostatModeCommandPayload(
                commandThermostatId,
                mode,
                this.deps.state.thermostatCfgById.get(commandThermostatId),
            );
            await this.sendKseniaCommand('WRITE_CFG', 'CFG_ALL', {
                ID_LOGIN: 'true',
                CFG_THERMOSTATS: [cfgEntry],
            }, {
                awaitResponse: true,
                responseCmds: ['WRITE_CFG_RES'],
                timeoutMs: CommandService.THERMOSTAT_ACK_TIMEOUT_MS,
            });
            this.deps.state.thermostatCfgById.set(commandThermostatId, cfgEntry);
        });
    }
    public async setThermostatTemperature(thermostatId: string, temperature: number): Promise<void> {
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const safeTemperature = clampValue(temperature, 5, 40);
        const outputThermostatId = stripDevicePrefix(thermostatId);
        const commandThermostatId = await this.resolveThermostatCommandId(outputThermostatId);
        await this.deps.commandDispatcher.enqueueDeviceCommand(thermostatId, async (): Promise<void> => {
            await this.primeThermostatConfigCache(commandThermostatId);
            const cfgEntry = buildThermostatSetpointCommandPayload({
                systemThermostatId: commandThermostatId,
                temperature: safeTemperature,
                seasonById: this.thermostatWriteSeasonById,
                existingCfg: this.deps.state.thermostatCfgById.get(commandThermostatId),
            });
            await this.sendKseniaCommand('WRITE_CFG', 'CFG_ALL', {
                ID_LOGIN: 'true',
                CFG_THERMOSTATS: [cfgEntry],
            }, {
                awaitResponse: true,
                responseCmds: ['WRITE_CFG_RES'],
                timeoutMs: CommandService.THERMOSTAT_ACK_TIMEOUT_MS,
            });
            this.deps.state.thermostatCfgById.set(commandThermostatId, cfgEntry);
        });
    }
    private async resolveThermostatCommandId(outputThermostatId: string): Promise<string> {
        if (
            this.deps.state.thermostatProgramById.size === 0
            && !this.deps.state.missingThermostatProgramWarningOutputIds.has(outputThermostatId)
        ) {
            this.deps.log.warn(
                `PRG_THERMOSTATS unavailable for thermostat_${outputThermostatId}, using degraded command fallback`,
            );
            this.deps.state.missingThermostatProgramWarningOutputIds.add(outputThermostatId);
        }

        const resolvedCommandId = await resolveThermostatCommandId({
            outputThermostatId,
            hasProgramMapping: this.deps.state.thermostatProgramById.size > 0,
            cachedCommandId: this.deps.state.thermostatCommandIdByOutputId.get(outputThermostatId),
            manualCommandId: this.getManualThermostatCommandId(outputThermostatId),
            programCommandId: this.deps.state.thermostatProgramIdByOutputId.get(outputThermostatId),
            primeConfig: (candidateId): Promise<boolean> => this.primeThermostatConfigCache(candidateId),
            rememberCommandId: (resolvedCommandId): void => { this.deps.state.thermostatCommandIdByOutputId.set(outputThermostatId, resolvedCommandId); },
            onResolvedAlias: (resolvedCommandId): void => this.deps.log.info(`Thermostat command ID resolved thermostat_${outputThermostatId} -> ${resolvedCommandId}`),
        });
        this.logThermostatRouting(outputThermostatId);
        return resolvedCommandId;
    }
    private logThermostatRouting(outputThermostatId: string): void {
        if (this.deps.logLevel < LogLevel.DEBUG) {
            return;
        }
        const configId = this.deps.state.thermostatProgramIdByOutputId.get(outputThermostatId)
            ?? this.deps.state.thermostatCommandIdByOutputId.get(outputThermostatId)
            ?? outputThermostatId;
        const domusSensorId = this.deps.state.thermostatToDomus.get(outputThermostatId) ?? 'NA';
        const source = this.deps.state.thermostatProgramIdByOutputId.has(outputThermostatId) ? 'prg_thermostats' : 'fallback';
        this.deps.log.debug(`thermostat_${outputThermostatId} => cfg:${configId} domus:${domusSensorId} source:${source}`);
    }
    private getManualThermostatCommandId(outputThermostatId: string): string | undefined { const pair = this.deps.state.domusThermostatConfig.manualCommandPairs.find((item) => stripDevicePrefix(item.thermostatOutputId) === outputThermostatId); return pair ? stripDevicePrefix(pair.commandThermostatId) : undefined; }
    private async primeThermostatConfigCache(systemThermostatId: string): Promise<boolean> {
        if (this.deps.state.thermostatCfgById.has(systemThermostatId)) return true;
        try {
            await this.sendKseniaCommand('READ', 'CFG_THERMOSTATS', {
                ID_LOGIN: 'true',
                ID_READ: systemThermostatId,
                ID_ITEMS_RANGE: [systemThermostatId, systemThermostatId],
            }, { awaitResponse: true, responseCmds: ['READ_RES'], timeoutMs: CommandService.THERMOSTAT_ACK_TIMEOUT_MS });
            return this.deps.state.thermostatCfgById.has(systemThermostatId);
        } catch (error: unknown) {
            if (this.deps.state.thermostatCfgById.has(systemThermostatId)) return true;
            if (this.deps.logLevel >= LogLevel.DEBUG) this.deps.log.debug(`Unable to read CFG_THERMOSTATS for thermostat ${systemThermostatId}: ${error instanceof Error ? error.message : String(error)}`);
            await new Promise((resolve): void => { setTimeout(resolve, 150); });
            if (this.deps.state.thermostatCfgById.has(systemThermostatId)) return true;
            return false;
        }
    }
    public async triggerScenario(scenarioId: string): Promise<void> {
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const systemScenarioId = stripDevicePrefix(scenarioId);
        await this.deps.commandDispatcher.enqueueDeviceCommand(scenarioId, async (): Promise<void> => {
            await this.sendKseniaCommand('CMD_USR', 'CMD_EXE_SCENARIO', {
                ID_LOGIN: 'true',
                PIN: 'true',
                SCENARIO: {
                    ID: systemScenarioId,
                },
            });
        });
        this.deps.log.info(`Scenario ${systemScenarioId} executed`);
    }
    private async sendKseniaCommand(
        cmd: string,
        payloadType: string,
        payload: KseniaCommandPayload,
        options: SendCommandOptions = {},
    ): Promise<void> {
        if (!this.deps.state.ws || this.deps.state.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected');
        }
        const processedPayload = this.buildPayload(payload);
        const id = Math.floor(Math.random() * 100000).toString();
        const message: KseniaMessage = {
            SENDER: this.deps.sender,
            RECEIVER: '', CMD: cmd, ID: id, PAYLOAD_TYPE: payloadType,
            PAYLOAD: processedPayload as KseniaMessagePayload, TIMESTAMP: Math.floor(Date.now() / 1000).toString(), CRC_16: '0x0000',
        };
        message.CRC_16 = calculateCRC16(JSON.stringify(message));
        const jsonMessage = JSON.stringify(message);
        const isPing = cmd === 'PING' || payloadType === 'HEARTBEAT';
        if (!isPing && this.deps.logLevel >= LogLevel.DEBUG) {
            this.deps.log.debug(`Sending: ${maskSensitiveData(jsonMessage)}`);
        }
        let pendingResponsePromise: Promise<void> | undefined;
        if (options.awaitResponse) {
            pendingResponsePromise = this.deps.commandDispatcher.registerPendingCommand(
                id,
                options.timeoutMs ?? this.deps.options.commandTimeoutMs ?? 8000,
                options.responseCmds,
            );
        }
        try {
            await this.sendRawMessage(jsonMessage);
            if (pendingResponsePromise) {
                await pendingResponsePromise;
            }
        } catch (error: unknown) {
            this.deps.commandDispatcher.clearPendingCommand(id);
            throw error;
        }
    }
    private buildPayload(payload: KseniaCommandPayload): KseniaCommandPayload {
        return {
            ...payload,
            ...(payload?.ID_LOGIN === 'true' && { ID_LOGIN: this.deps.state.idLogin }),
            ...(payload?.PIN === 'true' && { PIN: this.deps.pin }),
        };
    }
    private async sendRawMessage(rawMessage: string): Promise<void> { this.deps.emitRawMessage('out', rawMessage); await this.deps.wsTransport.send(this.deps.state.ws, rawMessage); }
}
