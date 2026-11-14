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
import { runIsolated } from '../isolation';
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
        runIsolated(this.deps.log, 'Raw message listener', () => this.deps.emitRawMessage('in', rawData));
        let message: KseniaMessage;
        try {
            message = JSON.parse(rawData) as KseniaMessage;
        } catch {
            // The parser's message quotes the frame: only its size is logged.
            this.deps.log.error(`Invalid JSON frame from the panel (${rawData.length} bytes)`);
            return;
        }
        if (message === null || typeof message !== 'object' || Array.isArray(message)) {
            this.deps.log.warn('Ignoring a panel frame that is not a JSON object');
            return;
        }

        if (this.deps.logLevel >= LogLevel.DEBUG) {
            const isHeartbeat = message.CMD === 'PING' || message.PAYLOAD_TYPE === 'HEARTBEAT';
            if (!isHeartbeat) {
                this.deps.log.debug(`Message: ${message.CMD} / ${message.PAYLOAD_TYPE}`);
            }
        }

        // Only an error that escapes every per-section and per-element guard lands here.
        runIsolated(this.deps.log, `Handling ${frameLabel(message)} frame`, () => this.deps.routeMessage(message));
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
            // Every login re-reads the whole configuration: a new discovery sync starts here.
            this.deps.callbacks.onSyncStarted?.();
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
        const frame = frameLabel(message);
        const section = (name: string, fn: () => void): void => runIsolated(this.deps.log, `${frame} ${name}`, fn);

        this.deps.log.info(`Response received: ${message.PAYLOAD_TYPE}`);

        if (message.PAYLOAD_TYPE === 'ZONES' && payload.ZONES) {
            const zones = payload.ZONES;
            section('ZONES', () => this.discovery.handleZones(zones));
        }

        if (message.PAYLOAD_TYPE === 'MULTI_TYPES') {
            const { OUTPUTS: outputs, SCENARIOS: scenarios, BUS_HAS: sensors } = payload;
            if (outputs) section('OUTPUTS', () => this.discovery.handleOutputs(outputs));
            if (scenarios) section('SCENARIOS', () => this.discovery.handleScenarios(scenarios));
            if (sensors) section('BUS_HAS', () => this.discovery.handleBusSensors(sensors));
            section('thermostat mapping', () => this.thermostats.afterMultiTypes());
        }

        const cfg = payload.CFG_THERMOSTATS;
        if (message.PAYLOAD_TYPE === 'CFG_THERMOSTATS' && Array.isArray(cfg)) {
            section('CFG_THERMOSTATS', () => this.thermostats.handleCfgThermostats(cfg));
        }

        const programs = payload.PRG_THERMOSTATS;
        if (message.PAYLOAD_TYPE === 'PRG_THERMOSTATS' && Array.isArray(programs)) {
            section('PRG_THERMOSTATS', () => this.thermostats.handlePrgThermostats(programs));
        }

        const initialStatus: RealtimeStatusData = {};
        if (message.PAYLOAD_TYPE === 'STATUS_OUTPUTS' && payload.STATUS_OUTPUTS) {
            this.deps.log.info(`Initial states for ${payload.STATUS_OUTPUTS.length} outputs`);
            this.thermostats.logInitialThermostatStates(payload.STATUS_OUTPUTS);
            initialStatus.STATUS_OUTPUTS = payload.STATUS_OUTPUTS;
        }
        if (message.PAYLOAD_TYPE === 'STATUS_BUS_HA_SENSORS' && payload.STATUS_BUS_HA_SENSORS) {
            this.deps.log.info(`Initial states for ${payload.STATUS_BUS_HA_SENSORS.length} sensors`);
            initialStatus.STATUS_BUS_HA_SENSORS = payload.STATUS_BUS_HA_SENSORS;
        }
        if (message.PAYLOAD_TYPE === 'STATUS_TEMPERATURES' && payload.STATUS_TEMPERATURES) {
            initialStatus.STATUS_TEMPERATURES = payload.STATUS_TEMPERATURES;
        }
        if (message.PAYLOAD_TYPE === 'STATUS_SYSTEM' && payload.STATUS_SYSTEM) {
            this.deps.log.info('Initial system temperatures');
            initialStatus.STATUS_SYSTEM = realtimeStatusOf(payload).STATUS_SYSTEM;
        }
        this.applyStatusGroups(frame, initialStatus);
    }

    public handleRealtimeResponse(message: KseniaMessage): void {
        this.applyStatusGroups(frameLabel(message), realtimeStatusOf(message.PAYLOAD));

        if (!this.deps.state.hasCompletedInitialSync) {
            this.deps.state.hasCompletedInitialSync = true;
            this.deps.callbacks.onInitialSyncComplete?.();
        }
    }

    public handleStatusUpdate(message: KseniaMessage): void {
        const frame = frameLabel(message);
        for (const [, data] of Object.entries(message.PAYLOAD)) {
            if (data && typeof data === 'object') {
                this.applyStatusGroups(frame, data as RealtimeStatusData);
            }
        }
    }

    /** Each status group of a frame is applied on its own: one failing group never drops the others. */
    private applyStatusGroups(frame: string, data: RealtimeStatusData): void {
        const section = (name: string, fn: () => void): void => runIsolated(this.deps.log, `${frame} ${name}`, fn);
        const { STATUS_OUTPUTS: outputs, STATUS_BUS_HA_SENSORS: sensors, STATUS_TEMPERATURES: temperatures } = data;
        const { STATUS_ZONES: zones, STATUS_SYSTEM: system } = data;
        if (outputs) section('STATUS_OUTPUTS', () => this.deps.statusUpdater.updateOutputStatuses(outputs));
        if (sensors) section('STATUS_BUS_HA_SENSORS', () => this.deps.statusUpdater.updateSensorStatuses(sensors));
        if (temperatures) {
            section('STATUS_TEMPERATURES', () => this.deps.thermostatStatusUpdater.updateTemperatureStatuses(temperatures));
        }
        if (zones) section('STATUS_ZONES', () => this.deps.statusUpdater.updateZoneStatuses(zones));
        if (system) section('STATUS_SYSTEM', () => this.deps.systemTemperatureUpdater.updateSystemTemperatures(system));
    }
}

function frameLabel(message: KseniaMessage): string {
    return `${String(message.CMD)}/${String(message.PAYLOAD_TYPE)}`;
}

/** The status groups of a READ_RES or REALTIME_RES payload. */
function realtimeStatusOf(payload: KseniaMessage['PAYLOAD']): RealtimeStatusData {
    return {
        STATUS_OUTPUTS: payload.STATUS_OUTPUTS,
        STATUS_BUS_HA_SENSORS: payload.STATUS_BUS_HA_SENSORS,
        STATUS_TEMPERATURES: payload.STATUS_TEMPERATURES,
        STATUS_ZONES: payload.STATUS_ZONES,
        STATUS_SYSTEM: payload.STATUS_SYSTEM as unknown as SystemTemperatureData[],
    };
}
