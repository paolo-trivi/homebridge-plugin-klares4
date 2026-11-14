import WebSocket from 'ws';
import type { Logger } from 'homebridge';
import { LogLevel } from '../log-levels';
import type { KseniaMessage } from '../types';
import type { CommandService } from './command-service';
import { DiscoveryReadHandler } from './discovery-read-handler';
import { ThermostatReadHandler } from './thermostat-read-handler';
import type { ThermostatStatusUpdater } from './thermostat-status-updater';
import { StatusUpdater } from './status-updater';
import { SystemTemperatureUpdater } from './system-temperature-updater';
import { recordLoginRejection, resetLoginRejections } from './login-rejection-guard';
import type {
    CallbackRegistry,
    RealtimeStatusData,
    SystemTemperatureData,
    WebSocketClientState,
} from './types';

interface MessageServiceDeps {
    state: WebSocketClientState;
    callbacks: CallbackRegistry;
    log: Logger;
    logLevel: LogLevel;
    debugEnabled: boolean;
    exposePartialArmScenarios?: boolean;
    statusUpdater: StatusUpdater;
    systemTemperatureUpdater: SystemTemperatureUpdater;
    thermostatStatusUpdater: ThermostatStatusUpdater;
    commandService: CommandService;
    routeMessage: (message: KseniaMessage) => void;
    emitRawMessage: (direction: 'in', rawMessage: string) => void;
    onLoginCompleted: () => void;
}

export class MessageService {
    private readonly thermostats: ThermostatReadHandler;
    private readonly discovery: DiscoveryReadHandler;

    constructor(private readonly deps: MessageServiceDeps) {
        this.thermostats = new ThermostatReadHandler({
            state: deps.state,
            log: deps.log,
            logLevel: deps.logLevel,
            debugEnabled: deps.debugEnabled,
            thermostatStatusUpdater: deps.thermostatStatusUpdater,
            emitDeviceStatusUpdate: (device): void => this.deps.callbacks.onDeviceStatusUpdate?.(device),
        });
        this.discovery = new DiscoveryReadHandler({
            state: deps.state,
            log: deps.log,
            exposePartialArmScenarios: deps.exposePartialArmScenarios,
            statusUpdater: deps.statusUpdater,
            thermostats: this.thermostats,
            emitDeviceDiscovered: (device): void => this.deps.callbacks.onDeviceDiscovered?.(device),
        });
    }

    public handleMessage(rawData: string): void {
        this.deps.emitRawMessage('in', rawData);
        try {
            const message = JSON.parse(rawData) as KseniaMessage;

            if (this.deps.logLevel >= LogLevel.DEBUG) {
                const isHeartbeat = message.CMD === 'PING' || message.PAYLOAD_TYPE === 'HEARTBEAT';
                if (!isHeartbeat) {
                    this.deps.log.debug(`Message: ${message.CMD} / ${message.PAYLOAD_TYPE}`);
                }
            }

            this.deps.routeMessage(message);
        } catch (error: unknown) {
            this.deps.log.error(
                'Message parsing error:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    public handleLoginResponse(message: KseniaMessage): void {
        const pendingLogin = this.deps.state.pendingLogin;
        if (!pendingLogin || pendingLogin.messageId === undefined || pendingLogin.messageId !== String(message.ID)) {
            this.deps.log.warn('Ignoring LOGIN_RES that does not answer the LOGIN in progress');
            return;
        }
        if (message.PAYLOAD?.RESULT === 'OK') {
            this.deps.state.idLogin = String(message.PAYLOAD.ID_LOGIN ?? '1');
            resetLoginRejections(this.deps.state);
            this.deps.log.info(`Login completed, ID_LOGIN: ${this.deps.state.idLogin}`);
            this.deps.state.pendingLogin?.resolve();
            this.deps.onLoginCompleted();
            this.deps.commandService.requestSystemData().catch((error: unknown): void => {
                this.deps.log.error(
                    'Error requesting system data:',
                    error instanceof Error ? error.message : String(error),
                );
            });
        } else {
            const reason = String(message.PAYLOAD?.RESULT_DETAIL ?? 'Unknown error');
            this.deps.log.error('Login failed:', reason);
            // Before the close below, whose handler schedules the reconnect.
            recordLoginRejection(this.deps.state, this.deps.log, reason);
            this.deps.state.pendingLogin?.reject(new Error(`Login failed: ${reason}`));
            if (this.deps.state.ws && this.deps.state.ws.readyState === WebSocket.OPEN) {
                this.deps.state.ws.close(1000, 'Login failed');
            }
        }
    }

    public handleReadResponse(message: KseniaMessage): void {
        const payload = message.PAYLOAD;

        this.deps.log.info(`Response received: ${message.PAYLOAD_TYPE}`);

        if (message.PAYLOAD_TYPE === 'ZONES' && payload.ZONES) {
            this.discovery.handleZones(payload.ZONES);
        }

        if (message.PAYLOAD_TYPE === 'MULTI_TYPES') {
            if (payload.OUTPUTS) {
                this.discovery.handleOutputs(payload.OUTPUTS);
            }
            if (payload.SCENARIOS) {
                this.discovery.handleScenarios(payload.SCENARIOS);
            }
            if (payload.BUS_HAS) {
                this.discovery.handleBusSensors(payload.BUS_HAS);
            }
            this.thermostats.afterMultiTypes();
        }

        if (message.PAYLOAD_TYPE === 'CFG_THERMOSTATS' && Array.isArray(payload.CFG_THERMOSTATS)) {
            this.thermostats.handleCfgThermostats(payload.CFG_THERMOSTATS);
        }

        if (message.PAYLOAD_TYPE === 'PRG_THERMOSTATS' && Array.isArray(payload.PRG_THERMOSTATS)) {
            this.thermostats.handlePrgThermostats(payload.PRG_THERMOSTATS);
        }

        if (message.PAYLOAD_TYPE === 'STATUS_OUTPUTS' && payload.STATUS_OUTPUTS) {
            this.deps.log.info(`Initial states for ${payload.STATUS_OUTPUTS.length} outputs`);
            this.thermostats.logInitialThermostatStates(payload.STATUS_OUTPUTS);
            this.deps.statusUpdater.updateOutputStatuses(payload.STATUS_OUTPUTS);
        }

        if (message.PAYLOAD_TYPE === 'STATUS_BUS_HA_SENSORS' && payload.STATUS_BUS_HA_SENSORS) {
            this.deps.log.info(`Initial states for ${payload.STATUS_BUS_HA_SENSORS.length} sensors`);
            this.deps.statusUpdater.updateSensorStatuses(payload.STATUS_BUS_HA_SENSORS);
        }

        if (message.PAYLOAD_TYPE === 'STATUS_TEMPERATURES' && payload.STATUS_TEMPERATURES) {
            this.deps.thermostatStatusUpdater.updateTemperatureStatuses(payload.STATUS_TEMPERATURES);
        }

        if (message.PAYLOAD_TYPE === 'STATUS_SYSTEM' && payload.STATUS_SYSTEM) {
            this.deps.log.info('Initial system temperatures');
            this.deps.systemTemperatureUpdater.updateSystemTemperatures(
                payload.STATUS_SYSTEM as unknown as SystemTemperatureData[],
            );
        }
    }

    public handleRealtimeResponse(message: KseniaMessage): void {
        const payload = message.PAYLOAD;
        if (payload.STATUS_OUTPUTS) {
            this.deps.statusUpdater.updateOutputStatuses(payload.STATUS_OUTPUTS);
        }
        if (payload.STATUS_BUS_HA_SENSORS) {
            this.deps.statusUpdater.updateSensorStatuses(payload.STATUS_BUS_HA_SENSORS);
        }
        if (payload.STATUS_TEMPERATURES) {
            this.deps.thermostatStatusUpdater.updateTemperatureStatuses(payload.STATUS_TEMPERATURES);
        }
        if (payload.STATUS_ZONES) {
            this.deps.statusUpdater.updateZoneStatuses(payload.STATUS_ZONES);
        }
        if (payload.STATUS_SYSTEM) {
            this.deps.systemTemperatureUpdater.updateSystemTemperatures(
                payload.STATUS_SYSTEM as unknown as SystemTemperatureData[],
            );
        }

        if (!this.deps.state.hasCompletedInitialSync) {
            this.deps.state.hasCompletedInitialSync = true;
            this.deps.callbacks.onInitialSyncComplete?.();
        }
    }

    public handleStatusUpdate(message: KseniaMessage): void {
        const payload = message.PAYLOAD;
        for (const [, data] of Object.entries(payload)) {
            if (data && typeof data === 'object') {
                const statusData = data as RealtimeStatusData;

                if (statusData.STATUS_OUTPUTS) {
                    this.deps.statusUpdater.updateOutputStatuses(statusData.STATUS_OUTPUTS);
                }
                if (statusData.STATUS_BUS_HA_SENSORS) {
                    this.deps.statusUpdater.updateSensorStatuses(statusData.STATUS_BUS_HA_SENSORS);
                }
                if (statusData.STATUS_TEMPERATURES) {
                    this.deps.thermostatStatusUpdater.updateTemperatureStatuses(statusData.STATUS_TEMPERATURES);
                }
                if (statusData.STATUS_ZONES) {
                    this.deps.statusUpdater.updateZoneStatuses(statusData.STATUS_ZONES);
                }
                if (statusData.STATUS_SYSTEM) {
                    this.deps.systemTemperatureUpdater.updateSystemTemperatures(statusData.STATUS_SYSTEM);
                }
            }
        }
    }
}
