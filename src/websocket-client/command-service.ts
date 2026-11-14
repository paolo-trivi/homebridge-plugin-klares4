import type { Logger } from 'homebridge';
import { LogLevel, maskSensitiveData } from '../log-levels';
import { stripDevicePrefix } from '../device-id';
import type { ThermostatMode } from '../thermostat-mode';
import type { CommandDispatcher } from '../websocket/command-dispatcher';
import type { OutputCommandConfirmationTracker } from '../websocket/output-command-confirmation';
import { clampValue } from '../websocket/device-state-projector';
import type { WsTransport } from '../websocket/ws-transport';
import { ThermostatCommandService } from './thermostat-command-service';
import type { KseniaDevice, KseniaMessage, KseniaWebSocketOptions } from '../types';
import type { KseniaCommandPayload, RawMessageDirection, SendCommandOptions, WebSocketClientState } from './types';
import { calculateCRC16 } from './crc16';
import { CommandSender } from './command-sender';
import { resolveScenarioExposure, scenarioOptInIds } from './device-parsers';
import { type MutationOutcome, mutationOptions, reportMutationOutcome } from './command-outcome';
import { coverTargetMatches, dimmerLevelMatches, lightStateMatches } from './output-state-matchers';
import { ValidationKlaresError } from '../errors';

const SCENARIO_REFUSAL = {
    'arming': 'it arms or disarms the alarm',
    'partial-arm': 'it partially arms the alarm (exposePartialArmScenarios is off)',
    'unknown-category': 'its category is not a known harmless one (list it in exposeScenarios to allow it)',
} as const;

/** WS-08: NaN and Infinity used to become "close" / "off" through the clamp. */
function requireFinite(value: unknown, kind: string, deviceId: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationKlaresError(`${kind} ${String(deviceId)}: value must be a finite number`);
    }
    return value;
}

interface CommandServiceDeps {
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
    /** Realtime status channel: an acknowledged thermostat write reaches HomeKit, Matter and MQTT through it. */
    emitDeviceStatusUpdate?: (device: KseniaDevice) => void;
}

export class CommandService {
    private readonly thermostatCommands: ThermostatCommandService;
    private readonly commandSender: CommandSender;

    constructor(private readonly deps: CommandServiceDeps) {
        this.commandSender = new CommandSender(deps);
        // Late-bound so a replaced sendKseniaCommand (tests) is still the one used.
        this.thermostatCommands = new ThermostatCommandService({
            state: deps.state,
            log: deps.log,
            logLevel: deps.logLevel,
            commandDispatcher: deps.commandDispatcher,
            commandTimeoutMs: deps.options.commandTimeoutMs ?? 8000,
            send: (cmd, payloadType, payload, options) => this.sendKseniaCommand(cmd, payloadType, payload, options),
            emitDeviceStatusUpdate: deps.emitDeviceStatusUpdate,
        });
    }

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
        this.deps.commandDispatcher.noteFireAndForget(loginMessage.ID);
        if (this.deps.state.pendingLogin) this.deps.state.pendingLogin.messageId = loginMessage.ID;
        this.deps.log.info('Executing login...');
        const messageStr = JSON.stringify(loginMessage);
        if (this.deps.logLevel >= LogLevel.DEBUG) this.deps.log.debug(`Sending: ${maskSensitiveData(messageStr)}`);
        await this.commandSender.sendRaw(messageStr);
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
        if (typeof on !== 'boolean') throw new ValidationKlaresError(`Light ${String(lightId)}: on/off must be a boolean`);
        const systemOutputId = this.discoveredOutputId(lightId, 'light');
        const target = on ? 'ON' : 'OFF';
        await this.enqueueObservable(`light_${systemOutputId}`, async (): Promise<void> => {
            const outcome = await this.sendOutputCommand(
                systemOutputId, target, mutationOptions(systemOutputId, lightStateMatches(on)),
            );
            reportMutationOutcome(this.deps.log, 'Light', systemOutputId, target, outcome);
        });
    }

    public async dimLight(lightId: string, brightness: number): Promise<void> {
        const safeBrightness = clampValue(Math.round(requireFinite(brightness, 'Dimmer', lightId)), 0, 100);
        const systemOutputId = this.discoveredOutputId(lightId, 'light');
        await this.enqueueObservable(`light_${systemOutputId}`, async (): Promise<void> => {
            const outcome = await this.sendOutputCommand(
                systemOutputId, safeBrightness.toString(), mutationOptions(systemOutputId, dimmerLevelMatches(safeBrightness)),
            );
            reportMutationOutcome(this.deps.log, 'Dimmer', systemOutputId, `${safeBrightness}%`, outcome);
        });
    }

    public async moveCover(coverId: string, position: number): Promise<void> {
        const safePosition = clampValue(Math.round(requireFinite(position, 'Cover', coverId)), 0, 100);
        const systemOutputId = this.discoveredOutputId(coverId, 'cover');
        const command = safePosition === 0 ? 'DOWN' : safePosition === 100 ? 'UP' : safePosition.toString();
        await this.enqueueObservable(`cover_${systemOutputId}`, async (): Promise<void> => {
            const outcome = await this.sendOutputCommand(
                systemOutputId, command, mutationOptions(systemOutputId, coverTargetMatches(safePosition)),
            );
            reportMutationOutcome(this.deps.log, 'Cover', systemOutputId, command, outcome);
        });
    }

    public async toggleGate(gateId: string): Promise<void> {
        const systemOutputId = this.discoveredOutputId(gateId, 'gate');
        await this.deps.commandDispatcher.enqueueDeviceCommand(`gate_${systemOutputId}`, async (): Promise<void> => {
            const outcome = await this.sendOutputCommand(systemOutputId, 'ON', mutationOptions());
            reportMutationOutcome(this.deps.log, 'Gate', systemOutputId, 'ON (momentary)', outcome);
        }, { policy: 'reject-while-busy' });
    }

    public async setThermostatMode(thermostatId: string, mode: ThermostatMode): Promise<void> {
        await this.thermostatCommands.setThermostatMode(thermostatId, mode);
    }

    public async setThermostatTemperature(thermostatId: string, temperature: number): Promise<void> {
        await this.thermostatCommands.setThermostatTemperature(thermostatId, temperature);
    }

    public async triggerScenario(scenarioId: string): Promise<void> {
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const systemScenarioId = stripDevicePrefix(String(scenarioId));
        this.assertScenarioAllowed(systemScenarioId);
        this.discoveredOutputId(scenarioId, 'scenario');
        await this.deps.commandDispatcher.enqueueDeviceCommand(`scenario_${systemScenarioId}`, async (): Promise<void> => {
            const outcome = await this.sendKseniaCommand('CMD_USR', 'CMD_EXE_SCENARIO', {
                ID_LOGIN: 'true',
                PIN: 'true',
                SCENARIO: {
                    ID: systemScenarioId,
                },
            }, mutationOptions());
            reportMutationOutcome(this.deps.log, 'Scenario', systemScenarioId, 'trigger', outcome);
        }, { policy: 'reject-while-busy' });
    }

    /** Defense in depth: never run a scenario the exposure policy hides, even if an accessory exists. */
    private assertScenarioAllowed(systemScenarioId: string): void {
        const category = this.deps.state.scenarioCategoryById?.get(systemScenarioId);
        if (category === undefined) {
            throw new ValidationKlaresError(`Scenario ${systemScenarioId} refused: not listed by the panel`);
        }
        const exposure = resolveScenarioExposure(
            category,
            this.deps.options.exposePartialArmScenarios ?? false,
            scenarioOptInIds(this.deps.options.exposeScenarios).has(systemScenarioId),
        );
        if (!exposure.exposed) {
            throw new ValidationKlaresError(`Scenario ${systemScenarioId} refused: ${SCENARIO_REFUSAL[exposure.reason]}`);
        }
    }

    /**
     * Defense in depth: a command reaches only an output the client discovered
     * with that kind. An output the exposure policy hides is not in the client
     * state, so a stale accessory or a forged MQTT topic cannot drive it.
     */
    private discoveredOutputId(deviceId: string, type: 'light' | 'cover' | 'gate' | 'scenario'): string {
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const systemId = stripDevicePrefix(String(deviceId));
        if (this.deps.state.devices.get(`${type}_${systemId}`)?.type !== type) {
            throw new ValidationKlaresError(`Command refused: ${String(deviceId)} is not a ${type} discovered on the panel`);
        }
        return systemId;
    }

    /** Observable outputs: the latest request wins, and a request may not wait longer than a command timeout. */
    private enqueueObservable(key: string, command: () => Promise<void>): Promise<void> {
        return this.deps.commandDispatcher.enqueueDeviceCommand(key, command, {
            policy: 'latest-wins',
            maxWaitMs: this.deps.options.commandTimeoutMs ?? 8000,
        });
    }

    private sendOutputCommand(
        systemOutputId: string,
        sta: string,
        options: SendCommandOptions,
    ): Promise<MutationOutcome> {
        return this.sendKseniaCommand('CMD_USR', 'CMD_SET_OUTPUT', {
            ID_LOGIN: 'true',
            PIN: 'true',
            OUTPUT: { ID: systemOutputId, STA: sta },
        }, options);
    }

    private async sendKseniaCommand(
        cmd: string,
        payloadType: string,
        payload: KseniaCommandPayload,
        options: SendCommandOptions = {},
    ): Promise<MutationOutcome> {
        return this.commandSender.send(cmd, payloadType, payload, options);
    }
}
