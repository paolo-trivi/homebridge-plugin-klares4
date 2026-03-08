import WebSocket from 'ws';
import type { Logger } from 'homebridge';
import { LogLevel, maskSensitiveData } from '../log-levels';
import { stripDevicePrefix } from '../device-id';
import { domainModeToKsenia, type ThermostatMode } from '../thermostat-mode';
import { CommandDispatcher } from '../websocket/command-dispatcher';
import { clampValue } from '../websocket/device-state-projector';
import { WsTransport } from '../websocket/ws-transport';
import { buildThermostatModeCfgPayload, buildThermostatSetpointCfgPayload, updateThermostatSeasonHint } from './thermostat-write-payload';
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
}
export class CommandService {
    constructor(private readonly deps: CommandServiceDeps) {}
    private readonly thermostatWriteSeasonById: Map<string, 'WIN' | 'SUM'> = new Map();
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
        await this.sendMessage(loginMessage);
    }
    public async requestSystemData(): Promise<void> {
        if (!this.deps.state.idLogin) {
            this.deps.log.error('ID_LOGIN not available');
            return;
        }
        await this.sendKseniaCommand('READ', 'ZONES', {
            ID_LOGIN: this.deps.state.idLogin,
            ID_ITEMS_RANGE: ['ALL', 'ALL'],
        });
        await this.sendKseniaCommand('READ', 'MULTI_TYPES', {
            ID_LOGIN: this.deps.state.idLogin,
            TYPES: ['OUTPUTS', 'BUS_HAS', 'SCENARIOS'],
        });
        await this.sendKseniaCommand('READ', 'STATUS_OUTPUTS', {
            ID_LOGIN: this.deps.state.idLogin,
        });
        await this.sendKseniaCommand('READ', 'STATUS_BUS_HA_SENSORS', {
            ID_LOGIN: this.deps.state.idLogin,
        });
        await this.sendKseniaCommand('READ', 'STATUS_SYSTEM', {
            ID_LOGIN: this.deps.state.idLogin,
        });
        await this.sendKseniaCommand('REALTIME', 'REGISTER', {
            ID_LOGIN: this.deps.state.idLogin,
            TYPES: [
                'STATUS_ZONES',
                'STATUS_OUTPUTS',
                'STATUS_BUS_HA_SENSORS',
                'STATUS_SYSTEM',
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
            }, {
                awaitResponse: true,
                responseCmds: ['CMD_USR_RES'],
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
            }, {
                awaitResponse: true,
                responseCmds: ['CMD_USR_RES'],
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
            }, {
                awaitResponse: true,
                responseCmds: ['CMD_USR_RES'],
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
            }, {
                awaitResponse: true,
                responseCmds: ['CMD_USR_RES'],
            });
        });
        this.deps.log.info(`Gate command sent: Output ${systemOutputId} -> ON (momentary)`);
    }
    public async setThermostatMode(thermostatId: string, mode: ThermostatMode): Promise<void> {
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const systemThermostatId = stripDevicePrefix(thermostatId);
        updateThermostatSeasonHint(this.thermostatWriteSeasonById, systemThermostatId, mode);
        await this.deps.commandDispatcher.enqueueDeviceCommand(thermostatId, async (): Promise<void> => {
            try {
                await this.sendKseniaCommand('WRITE_CFG', 'CFG_ALL', {
                    ID_LOGIN: 'true',
                    CFG_THERMOSTATS: [
                        {
                            ID: systemThermostatId,
                            ...buildThermostatModeCfgPayload(mode),
                        },
                    ],
                }, {
                    awaitResponse: true,
                    responseCmds: ['WRITE_CFG_RES'],
                });
            } catch (error: unknown) {
                await this.sendKseniaCommand('WRITE', 'THERMOSTAT', {
                    ID_LOGIN: this.deps.state.idLogin,
                    ID_THERMOSTAT: systemThermostatId,
                    MODE: domainModeToKsenia(mode),
                }, {
                    awaitResponse: true,
                    responseCmds: ['WRITE_RES'],
                });
                this.deps.log.warn(`Thermostat mode fallback to legacy WRITE/THERMOSTAT for ${systemThermostatId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }
    public async setThermostatTemperature(thermostatId: string, temperature: number): Promise<void> {
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const safeTemperature = clampValue(temperature, 5, 40);
        const systemThermostatId = stripDevicePrefix(thermostatId);
        await this.deps.commandDispatcher.enqueueDeviceCommand(thermostatId, async (): Promise<void> => {
            try {
                await this.sendKseniaCommand('WRITE_CFG', 'CFG_ALL', {
                    ID_LOGIN: 'true',
                    CFG_THERMOSTATS: [
                        {
                            ID: systemThermostatId,
                            ACT_MODE: 'MAN',
                            ...buildThermostatSetpointCfgPayload(
                                this.thermostatWriteSeasonById,
                                systemThermostatId,
                                safeTemperature,
                            ),
                        },
                    ],
                }, {
                    awaitResponse: true,
                    responseCmds: ['WRITE_CFG_RES'],
                });
            } catch (error: unknown) {
                await this.sendKseniaCommand('WRITE', 'THERMOSTAT', {
                    ID_LOGIN: this.deps.state.idLogin,
                    ID_THERMOSTAT: systemThermostatId,
                    TARGET_TEMP: safeTemperature.toString(),
                }, {
                    awaitResponse: true,
                    responseCmds: ['WRITE_RES'],
                });
                this.deps.log.warn(`Thermostat temperature fallback to legacy WRITE/THERMOSTAT for ${systemThermostatId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
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
            }, {
                awaitResponse: true,
                responseCmds: ['CMD_USR_RES'],
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
    private async sendMessage(message: KseniaMessage): Promise<void> {
        const messageStr = JSON.stringify(message);
        this.deps.log.info(`Sending: ${maskSensitiveData(messageStr)}`);
        await this.sendRawMessage(messageStr);
    }
    private async sendRawMessage(rawMessage: string): Promise<void> {
        this.deps.emitRawMessage('out', rawMessage);
        await this.deps.wsTransport.send(this.deps.state.ws, rawMessage);
    }
}
