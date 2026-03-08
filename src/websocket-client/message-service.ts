import WebSocket from 'ws';
import type { Logger } from 'homebridge';
import { LogLevel } from '../log-levels';
import type {
    KseniaBusHaData,
    KseniaMessage,
    KseniaOutputStatusRaw,
    KseniaScenarioData,
    KseniaZoneData,
} from '../types';
import type { CommandService } from './command-service';
import { determineOutputType, isIgnoredScenarioCategory, parseOutputData, parseScenarioData, parseZoneData } from './device-parsers';
import { normalizeDomusSensorId } from './domus-thermostat-mapper';
import { refreshDomusThermostatMapping } from './domus-thermostat-mapping-runtime';
import { applyThermostatConfigSnapshot } from './thermostat-config-sync';
import { StatusUpdater } from './status-updater';
import { SystemTemperatureUpdater } from './system-temperature-updater';
import type {
    CallbackRegistry,
    RealtimeStatusData,
    WebSocketClientState,
} from './types';
interface MessageServiceDeps {
    state: WebSocketClientState;
    callbacks: CallbackRegistry;
    log: Logger;
    logLevel: LogLevel;
    debugEnabled: boolean;
    statusUpdater: StatusUpdater;
    systemTemperatureUpdater: SystemTemperatureUpdater;
    commandService: CommandService;
    routeMessage: (message: KseniaMessage) => void;
    emitRawMessage: (direction: 'in', rawMessage: string) => void;
    onLoginCompleted: () => void;
}

export class MessageService {
    constructor(private readonly deps: MessageServiceDeps) {}

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
        if (message.PAYLOAD?.RESULT === 'OK') {
            this.deps.state.idLogin = String(message.PAYLOAD.ID_LOGIN ?? '1');
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
            this.deps.log.info(`Found ${payload.ZONES.length} zones`);
            payload.ZONES.forEach((zone: KseniaZoneData): void => {
                const device = parseZoneData(zone);
                this.deps.state.devices.set(device.id, device);
                this.deps.callbacks.onDeviceDiscovered?.(device);
                this.deps.statusUpdater.applyPendingZoneStatus(zone.ID);
            });
        }

        if (message.PAYLOAD_TYPE === 'MULTI_TYPES') {
            if (payload.OUTPUTS) {
                this.deps.log.info(`Found ${payload.OUTPUTS.length} outputs`);
                payload.OUTPUTS.forEach((output): void => {
                    const category = output.CAT ?? output.TYPE ?? '';
                    const type = determineOutputType(category, output.MOD);
                    if (type === 'thermostat') {
                        this.deps.state.thermostatOutputs.set(output.ID, output);
                    }

                    if (type === 'thermostat' && this.deps.debugEnabled) {
                        this.deps.log.debug(
                            `Thermostat found - ID: ${output.ID}, DES: ${output.DES}, TYPE: ${output.TYPE}, CAT: ${output.CAT}`,
                        );
                    }

                    const device = parseOutputData(output);
                    if (device) {
                        this.deps.state.devices.set(device.id, device);
                        this.deps.callbacks.onDeviceDiscovered?.(device);
                        this.deps.statusUpdater.applyPendingOutputStatus(output.ID);
                    }
                });
            }

            if (payload.SCENARIOS) {
                this.deps.log.info(`Found ${payload.SCENARIOS.length} scenarios`);
                payload.SCENARIOS.forEach((scenario: KseniaScenarioData): void => {
                    if (isIgnoredScenarioCategory(scenario.CAT)) {
                        this.deps.log.debug(`Scenario ${scenario.DES} ignored (category ${scenario.CAT})`);
                        return;
                    }

                    const device = parseScenarioData(scenario);
                    if (device) {
                        this.deps.state.devices.set(device.id, device);
                        this.deps.callbacks.onDeviceDiscovered?.(device);
                    }
                });
            }

            if (payload.BUS_HAS) {
                this.deps.log.info(`Found ${payload.BUS_HAS.length} sensors`);
                payload.BUS_HAS.forEach((sensor: KseniaBusHaData): void => {
                    const normalizedSensorId = normalizeDomusSensorId(sensor.ID);
                    this.deps.state.domusSensors.set(normalizedSensorId, { ...sensor, ID: normalizedSensorId });
                    const baseName = sensor.DES || `Sensor ${normalizedSensorId}`;

                    const tempDevice = {
                        id: `sensor_temp_${normalizedSensorId}`,
                        type: 'sensor',
                        name: `${baseName} - Temperatura`,
                        description: `${baseName} - Temperatura`,
                        status: { sensorType: 'temperature', value: 0, unit: 'C' },
                    } as const;
                    this.deps.state.devices.set(tempDevice.id, tempDevice);
                    this.deps.callbacks.onDeviceDiscovered?.(tempDevice);

                    const humDevice = {
                        id: `sensor_hum_${normalizedSensorId}`,
                        type: 'sensor',
                        name: `${baseName} - Umidita`,
                        description: `${baseName} - Umidita`,
                        status: { sensorType: 'humidity', value: 50, unit: '%' },
                    } as const;
                    this.deps.state.devices.set(humDevice.id, humDevice);
                    this.deps.callbacks.onDeviceDiscovered?.(humDevice);

                    const lightDevice = {
                        id: `sensor_light_${normalizedSensorId}`,
                        type: 'sensor',
                        name: `${baseName} - Luminosita`,
                        description: `${baseName} - Luminosita`,
                        status: { sensorType: 'light', value: 100, unit: 'lux' },
                    } as const;
                    this.deps.state.devices.set(lightDevice.id, lightDevice);
                    this.deps.callbacks.onDeviceDiscovered?.(lightDevice);
                    this.deps.statusUpdater.applyPendingSensorStatus(normalizedSensorId);
                });
            }

            this.refreshDomusThermostatMapping();
            this.applyThermostatConfigSnapshot();
        }

        if (message.PAYLOAD_TYPE === 'CFG_THERMOSTATS' && Array.isArray(payload.CFG_THERMOSTATS)) {
            for (const entry of payload.CFG_THERMOSTATS) {
                if (!entry || typeof entry !== 'object') {
                    continue;
                }
                const thermostatId = String((entry as Record<string, unknown>).ID ?? '');
                if (!thermostatId) {
                    continue;
                }
                this.deps.state.thermostatCfgById.set(thermostatId, entry as Record<string, unknown>);
            }
            if (this.deps.logLevel >= LogLevel.DEBUG) {
                this.deps.log.debug(
                    `Cached thermostat configs: ${this.deps.state.thermostatCfgById.size}`,
                );
            }
            this.applyThermostatConfigSnapshot();
        }

        if (message.PAYLOAD_TYPE === 'STATUS_OUTPUTS' && payload.STATUS_OUTPUTS) {
            this.deps.log.info(`Initial states for ${payload.STATUS_OUTPUTS.length} outputs`);
            if (this.deps.debugEnabled) {
                payload.STATUS_OUTPUTS.forEach((output: KseniaOutputStatusRaw): void => {
                    const thermostatDevice = this.deps.state.devices.get(`thermostat_${output.ID}`);
                    if (thermostatDevice) {
                        this.deps.log.debug(`Initial thermostat state ${output.ID}: ${JSON.stringify(output)}`);
                    }
                });
            }
            this.deps.statusUpdater.updateOutputStatuses(payload.STATUS_OUTPUTS);
        }

        if (message.PAYLOAD_TYPE === 'STATUS_BUS_HA_SENSORS' && payload.STATUS_BUS_HA_SENSORS) {
            this.deps.log.info(`Initial states for ${payload.STATUS_BUS_HA_SENSORS.length} sensors`);
            this.deps.statusUpdater.updateSensorStatuses(payload.STATUS_BUS_HA_SENSORS);
        }

        if (message.PAYLOAD_TYPE === 'STATUS_SYSTEM' && payload.STATUS_SYSTEM) {
            this.deps.log.info('Initial system temperatures');
            this.deps.systemTemperatureUpdater.updateSystemTemperatures(
                payload.STATUS_SYSTEM as unknown as import('./types').SystemTemperatureData[],
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
        if (payload.STATUS_ZONES) {
            this.deps.statusUpdater.updateZoneStatuses(payload.STATUS_ZONES);
        }
        if (payload.STATUS_SYSTEM) {
            this.deps.systemTemperatureUpdater.updateSystemTemperatures(
                payload.STATUS_SYSTEM as unknown as import('./types').SystemTemperatureData[],
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
                if (statusData.STATUS_ZONES) {
                    this.deps.statusUpdater.updateZoneStatuses(statusData.STATUS_ZONES);
                }
                if (statusData.STATUS_SYSTEM) {
                    this.deps.systemTemperatureUpdater.updateSystemTemperatures(statusData.STATUS_SYSTEM);
                }
            }
        }
    }

    private refreshDomusThermostatMapping(): void {
        refreshDomusThermostatMapping(this.deps.state, this.deps.log);
    }

    private applyThermostatConfigSnapshot(): void {
        applyThermostatConfigSnapshot({
            state: this.deps.state,
            emitDeviceStatusUpdate: (device): void => this.deps.callbacks.onDeviceStatusUpdate?.(device),
        });
    }
}
