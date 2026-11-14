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
import { frameResult, resultDetail } from '../websocket/protocol-result';
import { abandonDiscoveryRound, closeDiscoveryRound, openDiscoveryRound } from './discovered-device';
import { readInboundFrame } from './inbound-frame';
import { LoginResponseHandler } from './login-response-handler';
import { resetLoginRejections } from './login-rejection-guard';
import { DISCOVERY_FAMILIES, type DiscoverySection, readRefusalImpact } from './sync-read-policy';
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
    /** A failed login: counted, socket closed, reconnection backoff. */
    failLogin?: (error: Error) => void;
    /** The current session cannot complete its sync: closed and retried with backoff. */
    abortSession?: (reason: string) => void;
    /** The sync of the current session completed (REALTIME registration accepted). */
    onSyncCompleted?: () => void;
}

export class MessageService {
    private readonly thermostats: ThermostatReadHandler;
    private readonly discovery: DiscoveryReadHandler;
    private readonly login: LoginResponseHandler;
    /** Dropped frames per kind of rejection, for the rate-limited log. */
    private readonly rejectedFrames = new Map<string, number>();
    private missingCrcReported = false;

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
        this.login = new LoginResponseHandler({
            state: deps.state,
            log: deps.log,
            onLoginAccepted: (): void => this.onLoginAccepted(),
            failLogin: (error): void => this.deps.failLogin?.(error),
        });
    }

    public handleMessage(rawData: string): void {
        runIsolated(this.deps.log, 'Raw message listener', () => this.deps.emitRawMessage('in', rawData));
        const frame = readInboundFrame(rawData);
        if (frame.kind === 'rejected') {
            this.reportRejectedFrame(frame.reason);
            return;
        }
        const message = frame.message;
        if (frame.crc === 'missing' && !this.missingCrcReported) {
            this.missingCrcReported = true;
            this.deps.log.warn(`The panel sent a ${frameLabel(message)} frame without CRC_16; frames without CRC are accepted`);
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
        this.login.handle(message);
    }

    private onLoginAccepted(): void {
        resetLoginRejections(this.deps.state);
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
    }

    public handleReadResponse(message: KseniaMessage): void {
        const payload = message.PAYLOAD;
        const frame = frameLabel(message);
        const section = (name: string, fn: () => void): void => runIsolated(this.deps.log, `${frame} ${name}`, fn);

        const result = frameResult(message);
        if (result !== undefined && result !== 'OK') {
            this.handleRefusedRead(message, result);
            return;
        }
        this.deps.log.info(`Response received: ${message.PAYLOAD_TYPE}`);

        if (message.PAYLOAD_TYPE === 'ZONES') {
            const zones = payload.ZONES;
            this.discoverySection('ZONES', zones, () => this.discovery.handleZones(zones ?? []));
        }

        if (message.PAYLOAD_TYPE === 'MULTI_TYPES') {
            const { OUTPUTS: outputs, SCENARIOS: scenarios, BUS_HAS: sensors } = payload;
            this.discoverySection('OUTPUTS', outputs, () => this.discovery.handleOutputs(outputs ?? []));
            this.discoverySection('SCENARIOS', scenarios, () => this.discovery.handleScenarios(scenarios ?? []));
            this.discoverySection('BUS_HAS', sensors, () => this.discovery.handleBusSensors(sensors ?? []));
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
        const result = frameResult(message);
        if (result !== undefined && result !== 'OK') {
            // Without the registration no status change will ever arrive.
            this.abortSession(
                `The panel refused the realtime registration (${resultDetail(message) ?? result}): `
                + 'the synchronization is not complete, reconnecting',
            );
            return;
        }
        this.applyStatusGroups(frameLabel(message), realtimeStatusOf(message.PAYLOAD));

        if (!this.deps.state.hasCompletedInitialSync) {
            this.deps.state.hasCompletedInitialSync = true;
            this.deps.onSyncCompleted?.();
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

    private abortSession(reason: string): void {
        if (this.deps.abortSession) this.deps.abortSession(reason);
        else this.deps.log.warn(reason);
    }

    private handleRefusedRead(message: KseniaMessage, result: string): void {
        const detail = resultDetail(message);
        const what = `The panel refused the ${String(message.PAYLOAD_TYPE)} read (${detail ?? result})`;
        switch (readRefusalImpact(message.PAYLOAD_TYPE, detail)) {
            case 'expected':
                this.deps.log.debug(`${what}: not available on this panel`);
                return;
            case 'fatal':
                this.abortSession(`${what}: the synchronization is not complete, reconnecting`);
                return;
            default:
                this.deps.log.warn(`${what}; the synchronization continues without it`);
        }
    }

    /**
     * One discovery section of a configuration read. When it is a list and
     * its handler completes, the devices of its family that it no longer
     * lists leave the session state (deleted or re-categorised on the panel).
     */
    private discoverySection(name: DiscoverySection, items: unknown, handle: () => void): void {
        if (items === undefined) return;
        if (!Array.isArray(items)) {
            this.deps.log.warn(`Ignoring the ${name} section of a discovery read: it is not a list`);
            return;
        }
        const devices = this.deps.state.devices;
        let completed = false;
        openDiscoveryRound(devices);
        runIsolated(this.deps.log, `READ_RES ${name}`, () => {
            handle();
            completed = true;
        });
        if (!completed) {
            abandonDiscoveryRound(devices);
            return;
        }
        for (const id of closeDiscoveryRound(devices, DISCOVERY_FAMILIES[name])) {
            this.deps.log.info(`Device ${id} is no longer listed by the panel: it no longer receives status updates`);
        }
    }

    /** Rejected frames are dropped; per kind, the log grows by powers of ten, not by frame. */
    private reportRejectedFrame(reason: string): void {
        const kind = reason.replace(/ \(\d+ bytes\)/, '');
        const count = (this.rejectedFrames.get(kind) ?? 0) + 1;
        this.rejectedFrames.set(kind, count);
        if (/^10*$/.test(String(count))) {
            this.deps.log.error(`${reason}: dropped (${count} frame(s) dropped in this session so far)`);
        } else {
            this.deps.log.debug(`${reason}: dropped`);
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
