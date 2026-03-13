import type { Logger } from 'homebridge';

import { LogLevel, getEffectiveLogLevel } from '../log-levels';
import { CommandDispatcher } from '../websocket/command-dispatcher';
import { ProtocolRouter } from '../websocket/protocol-router';
import { WsTransport } from '../websocket/ws-transport';

import type {
    KseniaDevice,
    KseniaMessage,
    KseniaWebSocketOptions,
} from '../types';
import { createInitialWebSocketClientState } from './state';
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

    constructor(
        private readonly ip: string,
        private readonly port: number,
        private readonly useHttps: boolean,
        private readonly sender: string,
        private readonly pin: string,
        private readonly log: Logger,
        private readonly options: KseniaWebSocketOptions = {},
    ) {
        this.options = {
            debug: false,
            logLevel: LogLevel.NORMAL,
            reconnectInterval: 5000,
            heartbeatInterval: 30000,
            commandTimeoutMs: 8000,
            allowInsecureTls: false,
            loginTimeoutMs: 10000,
            ...options,
        };
        this.state = createInitialWebSocketClientState(this.options.domusThermostat, this.options.ksaCache);
        this.logLevel = getEffectiveLogLevel(this.options.logLevel, this.options.debug);
        this.wsTransport = new WsTransport(this.log);

        this.statusUpdater = new StatusUpdater({
            state: this.state,
            log: this.log,
            logLevel: this.logLevel,
            debugEnabled: this.options.debug ?? false,
            emitDeviceStatusUpdate: (device: KseniaDevice): void => {
                this.onDeviceStatusUpdate?.(device);
            },
        });

        this.systemTemperatureUpdater = new SystemTemperatureUpdater({
            state: this.state,
            log: this.log,
            logLevel: this.logLevel,
            debugEnabled: this.options.debug ?? false,
            emitDeviceDiscovered: (device: KseniaDevice): void => {
                this.onDeviceDiscovered?.(device);
            },
            emitDeviceStatusUpdate: (device: KseniaDevice): void => {
                this.onDeviceStatusUpdate?.(device);
            },
        });

        this.thermostatStatusUpdater = new ThermostatStatusUpdater({
            state: this.state,
            emitDeviceStatusUpdate: (device: KseniaDevice): void => {
                this.onDeviceStatusUpdate?.(device);
            },
        });

        this.commandService = new CommandService({
            state: this.state,
            sender: this.sender,
            pin: this.pin,
            log: this.log,
            logLevel: this.logLevel,
            options: this.options,
            commandDispatcher: this.commandDispatcher,
            wsTransport: this.wsTransport,
            emitRawMessage: (direction, rawMessage): void => {
                this.emitRawMessage(direction, rawMessage);
            },
        });

        let routeMessage = (_message: KseniaMessage): void => undefined;
        let onLoginCompleted = (): void => undefined;

        this.messageService = new MessageService({
            state: this.state,
            callbacks: {
                onDeviceDiscovered: (device: KseniaDevice): void => this.onDeviceDiscovered?.(device),
                onDeviceStatusUpdate: (device: KseniaDevice): void => this.onDeviceStatusUpdate?.(device),
                onInitialSyncComplete: (): void => this.onInitialSyncComplete?.(),
            },
            log: this.log,
            logLevel: this.logLevel,
            debugEnabled: this.options.debug ?? false,
            statusUpdater: this.statusUpdater,
            systemTemperatureUpdater: this.systemTemperatureUpdater,
            thermostatStatusUpdater: this.thermostatStatusUpdater,
            commandService: this.commandService,
            routeMessage: (message: KseniaMessage): void => routeMessage(message),
            emitRawMessage: (_direction, rawMessage): void => {
                this.emitRawMessage('in', rawMessage);
            },
            onLoginCompleted: (): void => onLoginCompleted(),
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
            onConnected: (): void => {
                this.onConnected?.();
            },
            onDisconnected: (): void => {
                this.onDisconnected?.();
            },
            executeLogin: (): Promise<void> => this.commandService.sendLoginCommand(),
        });

        onLoginCompleted = (): void => {
            this.connectionService.startHeartbeat();
        };
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

    private emitRawMessage(direction: RawMessageDirection, rawMessage: string): void {
        for (const listener of this.rawMessageListeners) {
            listener(direction, rawMessage);
        }
    }
}
