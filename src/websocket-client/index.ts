import type { Logger } from 'homebridge';

import { LogLevel, getEffectiveLogLevel } from '../log-levels';
import { markStatusObserved } from '../device-observation';
import { stripDevicePrefix } from '../device-id';
import { isIgnoredScenarioCategory, scenarioOptInIds } from './device-parsers';
import { isHiddenByExposurePolicy } from './exposure-report';
import { CommandDispatcher } from '../websocket/command-dispatcher';
import { ProtocolRouter } from '../websocket/protocol-router';
import { OutputCommandConfirmationTracker } from '../websocket/output-command-confirmation';
import { WsTransport } from '../websocket/ws-transport';

import type {
    KseniaDevice,
    KseniaMessage,
    KseniaWebSocketOptions,
} from '../types';
import { createInitialWebSocketClientState } from './state';
import { runIsolated } from '../isolation';
import { CommandService } from './command-service';
import { ConnectionService } from './connection-service';
import { MessageService } from './message-service';
import { StatusUpdater } from './status-updater';
import { SystemTemperatureUpdater } from './system-temperature-updater';
import { ThermostatStatusUpdater } from './thermostat-status-updater';
import type { RawMessageDirection, RawMessageListener } from './types';

export type { RawMessageDirection, RawMessageListener } from './types';

export class KseniaWebSocketClient {
    private readonly state: ReturnType<typeof createInitialWebSocketClientState>;
    private readonly logLevel: LogLevel;
    private readonly commandDispatcher = new CommandDispatcher();
    private readonly outputConfirmation = new OutputCommandConfirmationTracker();
    private readonly wsTransport: WsTransport;
    private readonly protocolRouter: ProtocolRouter;
    private readonly commandService: CommandService;
    private readonly connectionService: ConnectionService;
    private readonly statusUpdater: StatusUpdater;
    private readonly systemTemperatureUpdater: SystemTemperatureUpdater;
    private readonly thermostatStatusUpdater: ThermostatStatusUpdater;
    private readonly messageService: MessageService;
    private readonly rawMessageListeners: Set<RawMessageListener> = new Set();

    public onDeviceDiscovered?: (device: KseniaDevice) => void;
    public onDeviceStatusUpdate?: (device: KseniaDevice) => void;
    public onConnected?: () => void;
    public onDisconnected?: () => void;
    public onInitialSyncComplete?: () => void;
    /** Every successful login, before the discovery reads of the new sync are sent. */
    public onSyncStarted?: () => void;

    constructor(
        private readonly ip: string,
        private readonly port: number,
        private readonly useHttps: boolean,
        private readonly sender: string,
        private readonly pin: string,
        private readonly log: Logger,
        private readonly options: KseniaWebSocketOptions = {},
    ) {
        // `??` per key, not a spread of the defaults under `options`: an explicit
        // `undefined` must fall back to the default, not erase it (an undefined
        // reconnect interval is a timer that fires at once, forever).
        this.options = {
            ...options,
            debug: options.debug ?? false,
            logLevel: options.logLevel ?? LogLevel.NORMAL,
            reconnectInterval: options.reconnectInterval ?? 5000,
            heartbeatInterval: options.heartbeatInterval ?? 30000,
            commandTimeoutMs: options.commandTimeoutMs ?? 8000,
            // Security switches are opt-in with a real `true` only, whoever builds the client.
            allowInsecureTls: options.allowInsecureTls === true,
            loginTimeoutMs: options.loginTimeoutMs ?? 10000,
            connectTimeoutMs: options.connectTimeoutMs ?? 10000,
            exposePartialArmScenarios: options.exposePartialArmScenarios === true,
        };
        this.state = createInitialWebSocketClientState(this.options.domusThermostat, this.options.ksaCache);
        this.logLevel = getEffectiveLogLevel(this.options.logLevel, this.options.debug);
        this.wsTransport = new WsTransport(this.log);

        this.statusUpdater = new StatusUpdater({
            state: this.state,
            log: this.log,
            logLevel: this.logLevel,
            debugEnabled: this.options.debug ?? false,
            emitDeviceStatusUpdate: (device: KseniaDevice): void => this.emitStatus(device),
            observeOutputStatus: (status): void => {
                this.outputConfirmation.observe(status);
            },
        });

        this.systemTemperatureUpdater = new SystemTemperatureUpdater({
            state: this.state,
            log: this.log,
            logLevel: this.logLevel,
            debugEnabled: this.options.debug ?? false,
            emitDeviceDiscovered: (device: KseniaDevice): void => this.emitDiscovered(device),
            emitDeviceStatusUpdate: (device: KseniaDevice): void => this.emitStatus(device),
        });

        this.thermostatStatusUpdater = new ThermostatStatusUpdater({
            state: this.state,
            emitDeviceStatusUpdate: (device: KseniaDevice): void => this.emitStatus(device),
            log: this.log,
        });

        this.commandService = new CommandService({
            state: this.state,
            sender: this.sender,
            pin: this.pin,
            log: this.log,
            logLevel: this.logLevel,
            options: this.options,
            commandDispatcher: this.commandDispatcher,
            outputConfirmation: this.outputConfirmation,
            wsTransport: this.wsTransport,
            emitRawMessage: (direction, rawMessage): void => {
                this.emitRawMessage(direction, rawMessage);
            },
            emitDeviceStatusUpdate: (device: KseniaDevice): void => this.emitStatus(device),
        });

        let routeMessage = (_message: KseniaMessage): void => undefined;
        let onLoginCompleted = (): void => undefined;
        let connection: ConnectionService | undefined;

        this.messageService = new MessageService({
            state: this.state,
            callbacks: {
                onDeviceDiscovered: (device: KseniaDevice): void => this.emitDiscovered(device),
                onDeviceStatusUpdate: (device: KseniaDevice): void => this.emitStatus(device),
                onInitialSyncComplete: (): void => this.emitEvent('onInitialSyncComplete', this.onInitialSyncComplete),
                onSyncStarted: (): void => this.emitEvent('onSyncStarted', this.onSyncStarted),
            },
            log: this.log,
            logLevel: this.logLevel,
            debugEnabled: this.options.debug ?? false,
            exposePartialArmScenarios: this.options.exposePartialArmScenarios ?? false,
            exposeOutputs: this.options.exposeOutputs,
            exposeScenarios: this.options.exposeScenarios,
            statusUpdater: this.statusUpdater,
            systemTemperatureUpdater: this.systemTemperatureUpdater,
            thermostatStatusUpdater: this.thermostatStatusUpdater,
            commandService: this.commandService,
            routeMessage: (message: KseniaMessage): void => routeMessage(message),
            emitRawMessage: (_direction, rawMessage): void => {
                this.emitRawMessage('in', rawMessage);
            },
            onLoginCompleted: (): void => onLoginCompleted(),
            failLogin: (error: Error): void => connection?.failLogin(error),
            abortSession: (reason: string): void => connection?.abortSession(reason),
            onSyncCompleted: (): void => connection?.syncCompleted(),
        });

        this.protocolRouter = new ProtocolRouter({
            onResponseMessage: (message): void => {
                this.commandDispatcher.resolvePendingCommand(message);
            },
            onLoginResponse: (message): void => {
                this.messageService.handleLoginResponse(message);
            },
            onReadResponse: (message): void => {
                this.messageService.handleReadResponse(message);
            },
            onRealtimeResponse: (message): void => {
                this.messageService.handleRealtimeResponse(message);
            },
            onStatusUpdate: (message): void => {
                this.messageService.handleStatusUpdate(message);
            },
            onPing: (): void => {
                if (this.options.debug) {
                    this.log.debug('PING received from system');
                }
            },
            onUnhandled: (message): void => {
                if (this.options.debug) {
                    this.log.debug(`Unhandled message: ${message.CMD}`);
                }
            },
        });

        routeMessage = (message: KseniaMessage): void => {
            this.protocolRouter.route(message);
        };

        this.connectionService = new ConnectionService({
            state: this.state,
            ip: this.ip,
            port: this.port,
            useHttps: this.useHttps,
            log: this.log,
            options: this.options,
            commandDispatcher: this.commandDispatcher,
            wsTransport: this.wsTransport,
            onRawMessage: (raw: string): void => {
                this.messageService.handleMessage(raw);
            },
            onConnected: (): void => this.emitEvent('onConnected', this.onConnected),
            onDisconnected: (): void => {
                this.outputConfirmation.rejectAll(new Error('WebSocket disconnected'));
                this.emitEvent('onDisconnected', this.onDisconnected);
            },
            executeLogin: (): Promise<void> => this.commandService.sendLoginCommand(),
        });
        connection = this.connectionService;

        onLoginCompleted = (): void => {
            this.connectionService.startHeartbeat();
        };
    }

    /** True when the panel lists this scenario in a category the exposure policy does not expose. */
    public isScenarioSuppressed(scenarioId: string): boolean {
        const panelId = stripDevicePrefix(scenarioId);
        const category = this.state.scenarioCategoryById.get(panelId);
        return category !== undefined
            && isIgnoredScenarioCategory(
                category,
                this.options.exposePartialArmScenarios ?? false,
                scenarioOptInIds(this.options.exposeScenarios).has(panelId),
            );
    }

    /** True when the latest discovery read hid the output or scenario this device ID names. */
    public isHiddenByExposurePolicy(deviceId: string): boolean {
        return isHiddenByExposurePolicy(this.state, deviceId);
    }

    public async connect(): Promise<void> {
        await this.connectionService.connect();
    }

    public async switchLight(lightId: string, on: boolean): Promise<void> {
        await this.commandService.switchLight(lightId, on);
    }

    public async dimLight(lightId: string, brightness: number): Promise<void> {
        await this.commandService.dimLight(lightId, brightness);
    }

    public async moveCover(coverId: string, position: number): Promise<void> {
        await this.commandService.moveCover(coverId, position);
    }

    public async toggleGate(gateId: string): Promise<void> {
        await this.commandService.toggleGate(gateId);
    }

    public async setThermostatMode(
        thermostatId: string,
        mode: import('../thermostat-mode').ThermostatMode,
    ): Promise<void> {
        await this.commandService.setThermostatMode(thermostatId, mode);
    }

    public async setThermostatTemperature(thermostatId: string, temperature: number): Promise<void> {
        await this.commandService.setThermostatTemperature(thermostatId, temperature);
    }

    public async triggerScenario(scenarioId: string): Promise<void> {
        await this.commandService.triggerScenario(scenarioId);
    }

    public disconnect(): void {
        this.connectionService.disconnect();
    }

    public addRawMessageListener(listener: RawMessageListener): () => void {
        this.rawMessageListeners.add(listener);
        return (): void => {
            this.rawMessageListeners.delete(listener);
        };
    }

    public getAllDevices(): KseniaDevice[] {
        return Array.from(this.state.devices.values());
    }

    // Consumers (platform, debug capture) are isolated from the client: a
    // throwing consumer is logged with the device id and stack, and never
    // aborts the frame, the login or the send that emitted the event.
    private emitDiscovered(device: KseniaDevice): void {
        runIsolated(this.log, `onDeviceDiscovered handler for ${device.id}`, () => this.onDeviceDiscovered?.(device));
    }

    /** Every real status report goes through here: the device's state is now observed. */
    private emitStatus(device: KseniaDevice): void {
        markStatusObserved(device);
        runIsolated(this.log, `onDeviceStatusUpdate handler for ${device.id}`, () => this.onDeviceStatusUpdate?.(device));
    }

    private emitEvent(name: string, callback: (() => void) | undefined): void {
        runIsolated(this.log, `${name} handler`, () => callback?.());
    }

    private emitRawMessage(direction: RawMessageDirection, rawMessage: string): void {
        for (const listener of this.rawMessageListeners) {
            runIsolated(this.log, `Raw message listener (${direction})`, () => listener(direction, rawMessage));
        }
    }
}
