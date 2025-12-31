import WebSocket from 'ws';
import * as https from 'https';
import * as crypto from 'crypto';
import type { Logger } from 'homebridge';

import type {
    KseniaMessage,
    KseniaMessagePayload,
    KseniaWebSocketOptions,
    KseniaDevice,
    KseniaLight,
    KseniaCover,
    KseniaThermostat,
    KseniaSensor,
    KseniaZone,
    KseniaScenario,
    KseniaOutputData,
    KseniaZoneData,
    KseniaBusHaData,
    KseniaScenarioData,
    KseniaOutputStatusRaw,
    KseniaSensorStatusRaw,
    KseniaZoneStatusRaw,
    LightStatus,
    CoverStatus,
    ThermostatStatus,
    SensorStatus,
    ZoneStatus,
    ScenarioStatus,
} from './types';

/**
 * Interface for WebSocket connection options
 */
interface WebSocketConnectionOptions {
    rejectUnauthorized: boolean;
    agent?: https.Agent;
}

/**
 * Interface for real-time status data
 */
interface RealtimeStatusData {
    STATUS_OUTPUTS?: KseniaOutputStatusRaw[];
    STATUS_BUS_HA_SENSORS?: KseniaSensorStatusRaw[];
    STATUS_ZONES?: KseniaZoneStatusRaw[];
    STATUS_SYSTEM?: SystemTemperatureData[];
}

/**
 * Interface for system temperature data
 */
interface SystemTemperatureData {
    ID: string;
    TEMP?: {
        IN?: string;
        OUT?: string;
    };
}

/**
 * Interface for Ksenia command payload
 */
interface KseniaCommandPayload {
    ID_LOGIN?: string;
    PIN?: string;
    ID_ITEMS_RANGE?: string[];
    TYPES?: string[];
    OUTPUT?: {
        ID: string;
        STA: string;
    };
    ID_THERMOSTAT?: string;
    MODE?: string;
    TARGET_TEMP?: string;
    SCENARIO?: {
        ID: string;
    };
}

/**
 * WebSocket client for Ksenia Lares4 communication
 */
export class KseniaWebSocketClient {
    private ws?: WebSocket;
    private isConnected = false;
    private idLogin?: string;
    private heartbeatTimer?: ReturnType<typeof setInterval>;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private heartbeatPending = false;
    private lastPongReceived = 0;
    private reconnectAttempts = 0;
    private readonly maxReconnectDelay = 60000; // Max 60 seconds between attempts

    public onDeviceDiscovered?: (device: KseniaDevice) => void;
    public onDeviceStatusUpdate?: (device: KseniaDevice) => void;
    public onConnected?: () => void;
    public onDisconnected?: () => void;

    private readonly devices: Map<string, KseniaDevice> = new Map();

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
            reconnectInterval: 5000,
            heartbeatInterval: 30000,
            ...options,
        };
    }

    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const protocol = this.useHttps ? 'wss' : 'ws';
                const wsUrl = `${protocol}://${this.ip}:${this.port}/KseniaWsock/`;

                this.log.info(`Connecting to ${wsUrl}...`);

                const wsOptions: WebSocketConnectionOptions = {
                    rejectUnauthorized: false,
                };

                if (this.useHttps) {
                    wsOptions.agent = new https.Agent({
                        rejectUnauthorized: false,
                        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
                        secureProtocol: 'TLS_method',
                        ciphers: 'ALL:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA',
                    });
                }

                this.ws = new WebSocket(wsUrl, ['KS_WSOCK'], wsOptions);

                this.ws.on('open', (): void => {
                    this.log.info('WebSocket connected');
                    this.isConnected = true;
                    this.login()
                        .then((): void => {
                            this.onConnected?.();
                            resolve();
                        })
                        .catch(reject);
                });

                this.ws.on('message', (data: WebSocket.Data): void => {
                    this.handleMessage(data.toString());
                });

                this.ws.on('close', (code: number, reason: Buffer): void => {
                    this.log.warn(`WebSocket closed: ${code} - ${reason.toString()}`);
                    this.isConnected = false;
                    this.onDisconnected?.();
                    this.scheduleReconnect();
                });

                this.ws.on('error', (error: Error): void => {
                    this.log.error('WebSocket error:', error.message);
                    reject(error);
                });

                // Native WebSocket pong handler for heartbeat
                this.ws.on('pong', (): void => {
                    this.heartbeatPending = false;
                    this.lastPongReceived = Date.now();
                    if (this.options.debug) {
                        this.log.debug('Native WebSocket PONG received - connection healthy');
                    }
                });
            } catch (error: unknown) {
                reject(error);
            }
        });
    }

    private async login(): Promise<void> {
        const loginMessage: KseniaMessage = {
            SENDER: this.sender,
            RECEIVER: '',
            CMD: 'LOGIN',
            ID: Math.floor(Math.random() * 65535).toString(),
            PAYLOAD_TYPE: 'UNKNOWN',
            PAYLOAD: {
                PIN: this.pin,
            },
            TIMESTAMP: Math.floor(Date.now() / 1000).toString(),
            CRC_16: '0x0000',
        };

        loginMessage.CRC_16 = this.calculateCRC16(JSON.stringify(loginMessage));

        this.log.info('Executing login...');
        await this.sendMessage(loginMessage);
    }

    private handleMessage(data: string): void {
        try {
            const message = JSON.parse(data) as KseniaMessage;

            const isHeartbeat = message.CMD === 'PING' || message.PAYLOAD_TYPE === 'HEARTBEAT';
            const isGenericRealtime =
                message.CMD === 'REALTIME' && message.PAYLOAD_TYPE === 'CHANGES';

            if (this.options.debug || (!isHeartbeat && !isGenericRealtime)) {
                this.log.info(`Received: ${data}`);
            } else if (isHeartbeat || isGenericRealtime) {
                this.log.debug(`Debug: ${data}`);
            }

            switch (message.CMD) {
                case 'LOGIN_RES':
                    this.handleLoginResponse(message);
                    break;
                case 'READ_RES':
                    this.handleReadResponse(message);
                    break;
                case 'REALTIME_RES':
                    this.handleRealtimeResponse(message);
                    break;
                case 'REALTIME':
                    if (message.PAYLOAD_TYPE === 'CHANGES') {
                        this.handleStatusUpdate(message);
                    }
                    break;
                case 'STATUS_UPDATE':
                    this.handleStatusUpdate(message);
                    break;
                case 'PING':
                    if (this.options.debug) {
                        this.log.debug('PING received from system');
                    }
                    break;
                // Note: PONG is handled via native WebSocket 'pong' event, not as JSON message
                default:
                    if (this.options.debug) {
                        this.log.debug(`Unhandled message: ${message.CMD}`);
                    }
            }
        } catch (error: unknown) {
            this.log.error(
                'Message parsing error:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private handleLoginResponse(message: KseniaMessage): void {
        if (message.PAYLOAD?.RESULT === 'OK') {
            this.idLogin = String(message.PAYLOAD.ID_LOGIN ?? '1');
            this.log.info(`Login completed, ID_LOGIN: ${this.idLogin}`);
            this.startHeartbeat();
            this.requestSystemData().catch((error: unknown): void => {
                this.log.error(
                    'Error requesting system data:',
                    error instanceof Error ? error.message : String(error),
                );
            });
        } else {
            this.log.error('Login failed:', String(message.PAYLOAD?.RESULT_DETAIL ?? 'Unknown error'));
        }
    }

    private async requestSystemData(): Promise<void> {
        if (!this.idLogin) {
            this.log.error('ID_LOGIN not available');
            return;
        }

        this.log.info('Requesting system data...');

        await this.sendKseniaCommand('READ', 'ZONES', {
            ID_LOGIN: this.idLogin,
            ID_ITEMS_RANGE: ['ALL', 'ALL'],
        });

        await this.sendKseniaCommand('READ', 'MULTI_TYPES', {
            ID_LOGIN: this.idLogin,
            TYPES: ['OUTPUTS', 'BUS_HAS', 'SCENARIOS'],
        });

        await this.sendKseniaCommand('READ', 'STATUS_OUTPUTS', {
            ID_LOGIN: this.idLogin,
        });

        await this.sendKseniaCommand('READ', 'STATUS_BUS_HA_SENSORS', {
            ID_LOGIN: this.idLogin,
        });

        await this.sendKseniaCommand('READ', 'STATUS_SYSTEM', {
            ID_LOGIN: this.idLogin,
        });

        await this.sendKseniaCommand('REALTIME', 'REGISTER', {
            ID_LOGIN: this.idLogin,
            TYPES: [
                'STATUS_ZONES',
                'STATUS_OUTPUTS',
                'STATUS_BUS_HA_SENSORS',
                'STATUS_SYSTEM',
                'SCENARIOS',
            ],
        });
    }

    private handleReadResponse(message: KseniaMessage): void {
        const payload = message.PAYLOAD;

        this.log.info(`Response received: ${message.PAYLOAD_TYPE}`);

        if (message.PAYLOAD_TYPE === 'ZONES' && payload.ZONES) {
            this.log.info(`Found ${payload.ZONES.length} zones`);
            payload.ZONES.forEach((zone: KseniaZoneData): void => {
                const device = this.parseZoneData(zone);
                this.devices.set(device.id, device);
                this.onDeviceDiscovered?.(device);
            });
        }

        if (message.PAYLOAD_TYPE === 'MULTI_TYPES') {
            if (payload.OUTPUTS) {
                this.log.info(`Found ${payload.OUTPUTS.length} outputs`);
                payload.OUTPUTS.forEach((output: KseniaOutputData): void => {
                    const category = output.CAT ?? output.TYPE ?? '';
                    const type = this.determineOutputType(category);

                    if (type === 'thermostat' && this.options.debug) {
                        this.log.debug(
                            `Thermostat found - ID: ${output.ID}, DES: ${output.DES}, TYPE: ${output.TYPE}, CAT: ${output.CAT}`,
                        );
                    }

                    const device = this.parseOutputData(output);
                    if (device) {
                        this.devices.set(device.id, device);
                        this.onDeviceDiscovered?.(device);
                    }
                });
            }

            if (payload.SCENARIOS) {
                this.log.info(`Found ${payload.SCENARIOS.length} scenarios`);
                payload.SCENARIOS.forEach((scenario: KseniaScenarioData): void => {
                    if (scenario.CAT === 'ARM' || scenario.CAT === 'DISARM') {
                        this.log.debug(`Scenario ${scenario.DES} ignored (category ${scenario.CAT})`);
                        return;
                    }

                    const device = this.parseScenarioData(scenario);
                    if (device) {
                        this.devices.set(device.id, device);
                        this.onDeviceDiscovered?.(device);
                    }
                });
            }

            if (payload.BUS_HAS) {
                this.log.info(`Found ${payload.BUS_HAS.length} sensors`);
                payload.BUS_HAS.forEach((sensor: KseniaBusHaData): void => {
                    const baseName = sensor.DES || `Sensor ${sensor.ID}`;

                    const tempDevice: KseniaSensor = {
                        id: `sensor_temp_${sensor.ID}`,
                        type: 'sensor',
                        name: `${baseName} - Temperatura`,
                        description: `${baseName} - Temperatura`,
                        status: {
                            sensorType: 'temperature',
                            value: 0,
                            unit: 'C',
                        },
                    };
                    this.devices.set(tempDevice.id, tempDevice);
                    this.onDeviceDiscovered?.(tempDevice);

                    const humDevice: KseniaSensor = {
                        id: `sensor_hum_${sensor.ID}`,
                        type: 'sensor',
                        name: `${baseName} - Umidita`,
                        description: `${baseName} - Umidita`,
                        status: {
                            sensorType: 'humidity',
                            value: 50,
                            unit: '%',
                        },
                    };
                    this.devices.set(humDevice.id, humDevice);
                    this.onDeviceDiscovered?.(humDevice);

                    const lightDevice: KseniaSensor = {
                        id: `sensor_light_${sensor.ID}`,
                        type: 'sensor',
                        name: `${baseName} - Luminosita`,
                        description: `${baseName} - Luminosita`,
                        status: {
                            sensorType: 'light',
                            value: 100,
                            unit: 'lux',
                        },
                    };
                    this.devices.set(lightDevice.id, lightDevice);
                    this.onDeviceDiscovered?.(lightDevice);
                });
            }
        }

        if (message.PAYLOAD_TYPE === 'STATUS_OUTPUTS' && payload.STATUS_OUTPUTS) {
            this.log.info(`Initial states for ${payload.STATUS_OUTPUTS.length} outputs`);
            if (this.options.debug) {
                payload.STATUS_OUTPUTS.forEach((output: KseniaOutputStatusRaw): void => {
                    const thermostatDevice = this.devices.get(`thermostat_${output.ID}`);
                    if (thermostatDevice) {
                        this.log.debug(`Initial thermostat state ${output.ID}: ${JSON.stringify(output)}`);
                    }
                });
            }
            this.updateOutputStatuses(payload.STATUS_OUTPUTS);
        }

        if (message.PAYLOAD_TYPE === 'STATUS_BUS_HA_SENSORS' && payload.STATUS_BUS_HA_SENSORS) {
            this.log.info(`Initial states for ${payload.STATUS_BUS_HA_SENSORS.length} sensors`);
            this.updateSensorStatuses(payload.STATUS_BUS_HA_SENSORS);
        }

        if (message.PAYLOAD_TYPE === 'STATUS_SYSTEM' && payload.STATUS_SYSTEM) {
            this.log.info('Initial system temperatures');
            this.updateSystemTemperatures(payload.STATUS_SYSTEM as unknown as SystemTemperatureData[]);
        }
    }

    private handleRealtimeResponse(message: KseniaMessage): void {
        this.log.info('Real-time registration completed');

        const payload = message.PAYLOAD;
        if (payload.STATUS_OUTPUTS) {
            this.log.info(`Updating states for ${payload.STATUS_OUTPUTS.length} outputs`);
            this.updateOutputStatuses(payload.STATUS_OUTPUTS);
        }
        if (payload.STATUS_BUS_HA_SENSORS) {
            this.log.info(`Updating states for ${payload.STATUS_BUS_HA_SENSORS.length} sensors`);
            this.updateSensorStatuses(payload.STATUS_BUS_HA_SENSORS);
        }
        if (payload.STATUS_ZONES) {
            this.log.info(`Updating states for ${payload.STATUS_ZONES.length} zones`);
            this.updateZoneStatuses(payload.STATUS_ZONES);
        }
        if (payload.STATUS_SYSTEM) {
            this.log.info('Updating initial system temperatures');
            this.updateSystemTemperatures(payload.STATUS_SYSTEM as unknown as SystemTemperatureData[]);
        }
    }

    private handleStatusUpdate(message: KseniaMessage): void {
        const payload = message.PAYLOAD;
        this.log.debug(`handleStatusUpdate called, payload keys: ${Object.keys(payload)}`);

        for (const [, data] of Object.entries(payload)) {
            if (data && typeof data === 'object') {
                const statusData = data as RealtimeStatusData;

                if (statusData.STATUS_OUTPUTS) {
                    this.log.info(`Real-time update for ${statusData.STATUS_OUTPUTS.length} outputs`);
                    this.updateOutputStatuses(statusData.STATUS_OUTPUTS);
                }
                if (statusData.STATUS_BUS_HA_SENSORS) {
                    this.log.info(`Real-time update for ${statusData.STATUS_BUS_HA_SENSORS.length} sensors`);
                    this.updateSensorStatuses(statusData.STATUS_BUS_HA_SENSORS);
                }
                if (statusData.STATUS_ZONES) {
                    this.log.info(`Real-time update for ${statusData.STATUS_ZONES.length} zones`);
                    this.updateZoneStatuses(statusData.STATUS_ZONES);
                }
                if (statusData.STATUS_SYSTEM) {
                    this.log.info('System temperature update');
                    this.updateSystemTemperatures(statusData.STATUS_SYSTEM);
                }
            }
        }
    }

    private parseZoneData(zoneData: KseniaZoneData): KseniaZone {
        return {
            id: `zone_${zoneData.ID}`,
            type: 'zone',
            name: zoneData.DES || `Zone ${zoneData.ID}`,
            description: zoneData.DES || '',
            status: {
                armed: zoneData.STATUS === '1',
                bypassed: false,
                fault: false,
                open: zoneData.STATUS === '2',
            },
        };
    }

    private parseOutputData(outputData: KseniaOutputData): KseniaLight | KseniaCover | null {
        const category = outputData.CAT ?? outputData.TYPE ?? '';
        const categoryUpper = category.toUpperCase();
        const systemId = outputData.ID;

        if (categoryUpper === 'LIGHT') {
            return {
                id: `light_${systemId}`,
                type: 'light',
                name: outputData.DES || `Light ${systemId}`,
                description: outputData.DES || '',
                status: {
                    on: false,
                    brightness: undefined,
                    dimmable: false,
                },
            };
        } else if (categoryUpper === 'ROLL') {
            return {
                id: `cover_${systemId}`,
                type: 'cover',
                name: outputData.DES || `Cover ${systemId}`,
                description: outputData.DES || '',
                status: {
                    position: 0,
                    state: 'stopped',
                },
            };
        } else if (categoryUpper === 'GATE') {
            return {
                id: `cover_${systemId}`,
                type: 'cover',
                name: outputData.DES || `Gate ${systemId}`,
                description: outputData.DES || '',
                status: {
                    position: 0,
                    state: 'stopped',
                },
            };
        }

        this.log.debug(`Output ignored: ID ${systemId}, CAT: ${category}, DES: ${outputData.DES}`);
        return null;
    }

    private parseScenarioData(scenarioData: KseniaScenarioData): KseniaScenario | null {
        return {
            id: `scenario_${scenarioData.ID}`,
            type: 'scenario',
            name: scenarioData.DES || `Scenario ${scenarioData.ID}`,
            description: scenarioData.DES || '',
            status: {
                active: false,
            },
        };
    }

    private determineOutputType(category: string): 'light' | 'cover' | 'thermostat' | 'scenario' {
        const catUpper = category.toUpperCase();

        this.log.debug(`Determining type for category: "${category}" (normalized: "${catUpper}")`);

        if (catUpper === 'ROLL') {
            this.log.debug(`Identified as cover: ${category}`);
            return 'cover';
        }

        if (catUpper === 'LIGHT') {
            this.log.debug(`Identified as light: ${category}`);
            return 'light';
        }

        if (catUpper === 'GATE') {
            this.log.debug(`Identified as gate (treated as cover): ${category}`);
            return 'cover';
        }

        if (
            catUpper.includes('THERM') ||
            catUpper.includes('CLIMA') ||
            catUpper.includes('TEMP') ||
            catUpper.includes('RISCALD') ||
            catUpper.includes('RAFFRES') ||
            catUpper.includes('HVAC') ||
            catUpper.includes('TERMOS')
        ) {
            this.log.debug(`Identified as thermostat: ${category}`);
            return 'thermostat';
        }

        this.log.debug(`Identified as light (default): ${category}`);
        return 'light';
    }

    private updateOutputStatuses(outputs: KseniaOutputStatusRaw[]): void {
        outputs.forEach((output: KseniaOutputStatusRaw): void => {
            this.log.debug(
                `Output update ${output.ID}: STA=${output.STA}, POS=${output.POS}, TPOS=${output.TPOS}`,
            );

            const lightDevice = this.devices.get(`light_${output.ID}`);
            if (lightDevice && lightDevice.type === 'light') {
                const lightStatus = lightDevice.status as LightStatus;
                const wasOn = lightStatus.on;
                lightStatus.on = output.STA === 'ON';
                if (output.POS !== undefined) {
                    lightStatus.brightness = parseInt(output.POS, 10);
                    lightStatus.dimmable = true;
                }
                if (wasOn !== (output.STA === 'ON')) {
                    this.log.info(
                        `Light ${lightDevice.name} (Output ${output.ID}): ${output.STA === 'ON' ? 'ON' : 'OFF'}`,
                    );
                }
                this.onDeviceStatusUpdate?.(lightDevice);
            }

            const coverDevice = this.devices.get(`cover_${output.ID}`);
            if (coverDevice && coverDevice.type === 'cover') {
                const coverStatus = coverDevice.status as CoverStatus;
                const oldPos = coverStatus.position;
                const newPosition = this.mapCoverPosition(output.STA, output.POS);
                coverStatus.position = newPosition;
                coverStatus.targetPosition = parseInt(output.TPOS ?? output.POS ?? '0', 10);
                coverStatus.state = this.mapCoverState(output.STA, output.POS, output.TPOS);

                if (oldPos !== newPosition) {
                    this.log.info(
                        `Cover ${coverDevice.name} (Output ${output.ID}): ${output.STA} position ${newPosition}%`,
                    );
                }
                this.onDeviceStatusUpdate?.(coverDevice);
            }

            const thermostatDevice = this.devices.get(`thermostat_${output.ID}`);
            if (thermostatDevice && thermostatDevice.type === 'thermostat') {
                const thermostatStatus = thermostatDevice.status as ThermostatStatus;
                let updated = false;

                if (output.TEMP_CURRENT !== undefined) {
                    const oldCurrentTemp = thermostatStatus.currentTemperature;
                    const newCurrentTemp = parseFloat(output.TEMP_CURRENT);
                    thermostatStatus.currentTemperature = newCurrentTemp;
                    if (oldCurrentTemp !== newCurrentTemp) {
                        this.log.info(`${thermostatDevice.name}: Current temperature ${newCurrentTemp}C`);
                        updated = true;
                    }
                }

                if (output.TEMP_TARGET !== undefined) {
                    const oldTargetTemp = thermostatStatus.targetTemperature;
                    const newTargetTemp = parseFloat(output.TEMP_TARGET);
                    thermostatStatus.targetTemperature = newTargetTemp;
                    if (oldTargetTemp !== newTargetTemp) {
                        this.log.info(`${thermostatDevice.name}: Target temperature ${newTargetTemp}C`);
                        updated = true;
                    }
                }

                if (output.MODE !== undefined) {
                    const oldMode = thermostatStatus.mode;
                    const newMode = this.mapThermostatMode(output.MODE);
                    thermostatStatus.mode = newMode;
                    if (oldMode !== newMode) {
                        this.log.info(`${thermostatDevice.name}: Mode ${newMode}`);
                        updated = true;
                    }
                }

                if (updated) {
                    this.onDeviceStatusUpdate?.(thermostatDevice);
                } else if (this.options.debug) {
                    this.log.debug(`Debug thermostat ${output.ID}: ${JSON.stringify(output)}`);
                }
            }
        });
    }

    private updateSensorStatuses(sensors: KseniaSensorStatusRaw[]): void {
        sensors.forEach((sensor: KseniaSensorStatusRaw): void => {
            if (sensor.DOMUS) {
                this.log.debug(
                    `Sensor update ${sensor.ID}: TEM=${sensor.DOMUS.TEM}C, HUM=${sensor.DOMUS.HUM}%, LHT=${sensor.DOMUS.LHT}lux`,
                );

                const tempDevice = this.devices.get(`sensor_temp_${sensor.ID}`);
                if (tempDevice && tempDevice.type === 'sensor') {
                    const tempStatus = tempDevice.status as SensorStatus;
                    const oldTemp = tempStatus.value;
                    const newTemp = parseFloat(sensor.DOMUS.TEM ?? '0');
                    tempStatus.value = newTemp;
                    if (oldTemp !== newTemp && newTemp > 0) {
                        this.log.info(`${tempDevice.name}: ${newTemp}C`);
                    }
                    this.onDeviceStatusUpdate?.(tempDevice);
                }

                const humDevice = this.devices.get(`sensor_hum_${sensor.ID}`);
                if (humDevice && humDevice.type === 'sensor') {
                    const humStatus = humDevice.status as SensorStatus;
                    const oldHum = humStatus.value;
                    const newHum = parseInt(sensor.DOMUS.HUM ?? '50', 10);
                    humStatus.value = newHum;
                    if (oldHum !== newHum) {
                        this.log.info(`${humDevice.name}: ${newHum}%`);
                    }
                    this.onDeviceStatusUpdate?.(humDevice);
                }

                const lightSensorDevice = this.devices.get(`sensor_light_${sensor.ID}`);
                if (lightSensorDevice && lightSensorDevice.type === 'sensor') {
                    const lightStatus = lightSensorDevice.status as SensorStatus;
                    const oldLight = lightStatus.value;
                    const newLight = parseInt(sensor.DOMUS.LHT ?? '100', 10);
                    lightStatus.value = newLight;
                    if (oldLight !== newLight) {
                        this.log.info(`${lightSensorDevice.name}: ${newLight}lux`);
                    }
                    this.onDeviceStatusUpdate?.(lightSensorDevice);
                }
            }
        });
    }

    private updateZoneStatuses(zones: KseniaZoneStatusRaw[]): void {
        zones.forEach((zone: KseniaZoneStatusRaw): void => {
            this.log.debug(`Zone update ${zone.ID}: STA=${zone.STA}, BYP=${zone.BYP}, A=${zone.A}`);

            const zoneDevice = this.devices.get(`zone_${zone.ID}`);
            if (zoneDevice && zoneDevice.type === 'zone') {
                const zoneStatus = zoneDevice.status as ZoneStatus;
                const oldOpen = zoneStatus.open;
                const newOpen = zone.STA === 'A';

                zoneStatus.open = newOpen;
                zoneStatus.bypassed = zone.BYP === 'YES';
                zoneStatus.armed = zone.A === 'Y';
                zoneStatus.fault = zone.FM === 'T';

                if (oldOpen !== newOpen) {
                    this.log.info(`${zoneDevice.name}: ${newOpen ? 'OPEN/ALARM' : 'IDLE'}`);
                }

                this.onDeviceStatusUpdate?.(zoneDevice);
            }
        });
    }

    private mapCoverPosition(sta: string, pos?: string): number {
        if (pos !== undefined && pos !== '') {
            return parseInt(pos, 10);
        }

        switch (sta?.toUpperCase()) {
            case 'OPEN':
            case 'UP':
                return 100;
            case 'CLOSE':
            case 'DOWN':
                return 0;
            case 'STOP':
                return 50;
            default:
                return 0;
        }
    }

    private mapCoverState(
        sta: string,
        pos?: string,
        tpos?: string,
    ): 'stopped' | 'opening' | 'closing' {
        if (pos !== undefined && tpos !== undefined) {
            const currentPos = parseInt(pos, 10);
            const targetPos = parseInt(tpos, 10);

            if (currentPos === targetPos) {
                return 'stopped';
            } else if (currentPos < targetPos) {
                return 'opening';
            } else {
                return 'closing';
            }
        }

        switch (sta?.toUpperCase()) {
            case 'UP':
            case 'OPEN':
                return 'opening';
            case 'DOWN':
            case 'CLOSE':
                return 'closing';
            case 'STOP':
            default:
                return 'stopped';
        }
    }

    public async switchLight(lightId: string, on: boolean): Promise<void> {
        if (!this.idLogin) throw new Error('Not connected');

        const systemOutputId = lightId.replace('light_', '');

        await this.sendKseniaCommand('CMD_USR', 'CMD_SET_OUTPUT', {
            ID_LOGIN: 'true',
            PIN: 'true',
            OUTPUT: {
                ID: systemOutputId,
                STA: on ? 'ON' : 'OFF',
            },
        });

        this.log.info(`Light command sent: Output ${systemOutputId} -> ${on ? 'ON' : 'OFF'}`);
    }

    public async dimLight(lightId: string, brightness: number): Promise<void> {
        if (!this.idLogin) throw new Error('Not connected');

        const systemOutputId = lightId.replace('light_', '');
        await this.sendKseniaCommand('CMD_USR', 'CMD_SET_OUTPUT', {
            ID_LOGIN: 'true',
            PIN: 'true',
            OUTPUT: {
                ID: systemOutputId,
                STA: brightness.toString(),
            },
        });

        this.log.info(`Dimmer command sent: Output ${systemOutputId} -> ${brightness}%`);
    }

    public async moveCover(coverId: string, position: number): Promise<void> {
        if (!this.idLogin) throw new Error('Not connected');

        const systemOutputId = coverId.replace('cover_', '');

        let command: string;
        if (position === 0) {
            command = 'DOWN';
        } else if (position === 100) {
            command = 'UP';
        } else {
            command = position.toString();
        }

        await this.sendKseniaCommand('CMD_USR', 'CMD_SET_OUTPUT', {
            ID_LOGIN: 'true',
            PIN: 'true',
            OUTPUT: {
                ID: systemOutputId,
                STA: command,
            },
        });

        this.log.info(`Cover command sent: Output ${systemOutputId} -> ${command}`);
    }

    public async setThermostatMode(
        thermostatId: string,
        mode: 'off' | 'heat' | 'cool' | 'auto',
    ): Promise<void> {
        if (!this.idLogin) throw new Error('Not connected');

        let modeValue: string;
        switch (mode) {
            case 'heat':
                modeValue = '1';
                break;
            case 'cool':
                modeValue = '2';
                break;
            case 'auto':
                modeValue = '3';
                break;
            default:
                modeValue = '0';
                break;
        }

        await this.sendKseniaCommand('WRITE', 'THERMOSTAT', {
            ID_LOGIN: this.idLogin,
            ID_THERMOSTAT: thermostatId.replace('thermostat_', ''),
            MODE: modeValue,
        });
    }

    public async setThermostatTemperature(thermostatId: string, temperature: number): Promise<void> {
        if (!this.idLogin) throw new Error('Not connected');

        await this.sendKseniaCommand('WRITE', 'THERMOSTAT', {
            ID_LOGIN: this.idLogin,
            ID_THERMOSTAT: thermostatId.replace('thermostat_', ''),
            TARGET_TEMP: temperature.toString(),
        });
    }

    public async triggerScenario(scenarioId: string): Promise<void> {
        if (!this.idLogin) throw new Error('Not connected');

        const systemScenarioId = scenarioId.replace('scenario_', '');
        await this.sendKseniaCommand('CMD_USR', 'CMD_EXE_SCENARIO', {
            ID_LOGIN: 'true',
            PIN: 'true',
            SCENARIO: {
                ID: systemScenarioId,
            },
        });
        this.log.info(`Scenario ${systemScenarioId} executed`);
    }

    private async sendKseniaCommand(
        cmd: string,
        payloadType: string,
        payload: KseniaCommandPayload,
    ): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected');
        }

        const processedPayload = this.buildPayload(payload);

        const id = Math.floor(Math.random() * 100000).toString();
        const timestamp = Math.floor(Date.now() / 1000).toString();

        const message: KseniaMessage = {
            SENDER: this.sender,
            RECEIVER: '',
            CMD: cmd,
            ID: id,
            PAYLOAD_TYPE: payloadType,
            PAYLOAD: processedPayload as KseniaMessagePayload,
            TIMESTAMP: timestamp,
            CRC_16: '0x0000',
        };

        message.CRC_16 = this.calculateCRC16(JSON.stringify(message));

        const jsonMessage = JSON.stringify(message);

        const isPing = cmd === 'PING' || payloadType === 'HEARTBEAT';

        if (this.options.debug || !isPing) {
            this.log.info(`Sending: ${jsonMessage}`);
        } else {
            this.log.debug(`Debug: ${jsonMessage}`);
        }

        if (cmd === 'CMD_USR' && this.options.debug) {
            this.log.debug(`DEBUG - Command ${payloadType}: ${JSON.stringify(payload, null, 2)}`);
        }

        this.ws.send(jsonMessage);
    }

    private buildPayload(payload: KseniaCommandPayload): KseniaCommandPayload {
        return {
            ...payload,
            ...(payload?.ID_LOGIN === 'true' && { ID_LOGIN: this.idLogin }),
            ...(payload?.PIN === 'true' && { PIN: this.pin }),
        };
    }

    private async sendMessage(message: KseniaMessage): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected');
        }

        const messageStr = JSON.stringify(message);
        this.log.info(`Sending: ${messageStr}`);

        this.ws.send(messageStr);
    }

    private calculateCRC16(jsonString: string): string {
        const utf8: number[] = [];
        for (let i = 0; i < jsonString.length; i++) {
            const charcode = jsonString.charCodeAt(i);
            if (charcode < 0x80) {
                utf8.push(charcode);
            } else if (charcode < 0x800) {
                utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
            } else if (charcode < 0xd800 || charcode >= 0xe000) {
                utf8.push(
                    0xe0 | (charcode >> 12),
                    0x80 | ((charcode >> 6) & 0x3f),
                    0x80 | (charcode & 0x3f),
                );
            } else {
                i++;
                const surrogate =
                    0x10000 + (((charcode & 0x3ff) << 10) | (jsonString.charCodeAt(i) & 0x3f));
                utf8.push(
                    0xf0 | (surrogate >> 18),
                    0x80 | ((surrogate >> 12) & 0x3f),
                    0x80 | ((surrogate >> 6) & 0x3f),
                    0x80 | (surrogate & 0x3f),
                );
            }
        }

        const SEME_CRC_16_JSON = 0xffff;
        const GEN_POLY_JSON = 0x1021;
        const CRC_16 = '"CRC_16"';
        const dataLen =
            jsonString.lastIndexOf(CRC_16) + CRC_16.length + (utf8.length - jsonString.length);

        let crc = SEME_CRC_16_JSON;
        for (let i = 0; i < dataLen; i++) {
            const charCode = utf8[i];
            for (let iCrc = 0x80; iCrc; iCrc >>= 1) {
                const flagCrc = crc & 0x8000 ? 1 : 0;
                crc <<= 1;
                crc = crc & 0xffff;
                if (charCode & iCrc) {
                    crc++;
                }
                if (flagCrc) {
                    crc ^= GEN_POLY_JSON;
                }
            }
        }

        return '0x' + crc.toString(16).padStart(4, '0');
    }

    private startHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }

        this.lastPongReceived = Date.now();
        this.heartbeatPending = false;

        this.heartbeatTimer = setInterval((): void => {
            if (this.isConnected && this.ws) {
                // Check if previous heartbeat got a response
                if (this.heartbeatPending) {
                    const timeSinceLastPong = Date.now() - this.lastPongReceived;
                    const heartbeatTimeout = (this.options.heartbeatInterval ?? 30000) * 2;
                    
                    if (timeSinceLastPong > heartbeatTimeout) {
                        this.log.warn(`Heartbeat timeout: no PONG received for ${Math.round(timeSinceLastPong / 1000)}s - forcing reconnection`);
                        this.forceReconnect();
                        return;
                    }
                }

                this.heartbeatPending = true;
                // Use native WebSocket ping instead of application-level JSON command
                // Ksenia Lares4 does not support custom PING commands
                try {
                    this.ws.ping();
                    if (this.options.debug) {
                        this.log.debug('Native WebSocket PING sent');
                    }
                } catch (err: unknown) {
                    this.log.error(
                        'Heartbeat ping error:',
                        err instanceof Error ? err.message : String(err),
                    );
                }
            }
        }, this.options.heartbeatInterval);
    }

    private forceReconnect(): void {
        this.log.info('Forcing reconnection due to heartbeat timeout...');
        this.heartbeatPending = false;
        
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        
        if (this.ws) {
            this.ws.terminate(); // Force close without waiting for graceful shutdown
        }
        
        this.isConnected = false;
        this.onDisconnected?.();
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        // Exponential backoff with jitter
        const baseDelay = this.options.reconnectInterval ?? 5000;
        const exponentialDelay = Math.min(
            baseDelay * Math.pow(2, this.reconnectAttempts),
            this.maxReconnectDelay,
        );
        // Add jitter (±10%) to prevent thundering herd
        const jitter = exponentialDelay * 0.1 * (Math.random() * 2 - 1);
        const finalDelay = Math.round(exponentialDelay + jitter);

        this.log.info(
            `Scheduling reconnection attempt ${this.reconnectAttempts + 1} in ${Math.round(finalDelay / 1000)}s...`,
        );

        this.reconnectTimer = setTimeout((): void => {
            this.reconnectAttempts++;
            this.log.info(`Attempting reconnection (attempt ${this.reconnectAttempts})...`);
            this.connect()
                .then((): void => {
                    // Reset attempts on successful connection
                    this.reconnectAttempts = 0;
                    this.log.info('Reconnection successful');
                })
                .catch((err: unknown): void => {
                    this.log.error(
                        'Reconnection failed:',
                        err instanceof Error ? err.message : String(err),
                    );
                    this.scheduleReconnect();
                });
        }, finalDelay);
    }

    public disconnect(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        if (this.ws) {
            this.ws.close();
        }
        this.isConnected = false;
    }

    private mapThermostatMode(mode: string): 'off' | 'heat' | 'cool' | 'auto' {
        switch (mode?.toLowerCase()) {
            case 'heat':
            case 'heating':
            case 'riscaldamento':
                return 'heat';
            case 'cool':
            case 'cooling':
            case 'raffreddamento':
                return 'cool';
            case 'auto':
            case 'automatic':
            case 'automatico':
                return 'auto';
            case 'off':
            case 'spento':
            default:
                return 'off';
        }
    }

    private updateSystemTemperatures(systemData: SystemTemperatureData[]): void {
        systemData.forEach((system: SystemTemperatureData): void => {
            if (this.options.debug) {
                this.log.debug(`System data ${system.ID}: ${JSON.stringify(system)}`);
            }

            if (system.TEMP) {
                const internalTemp = system.TEMP.IN
                    ? parseFloat(system.TEMP.IN.replace('+', ''))
                    : undefined;
                const externalTemp = system.TEMP.OUT
                    ? parseFloat(system.TEMP.OUT.replace('+', ''))
                    : undefined;

                let logTemperatures = this.options.debug ?? false;

                if (internalTemp !== undefined) {
                    this.devices.forEach((device: KseniaDevice): void => {
                        if (device.type === 'thermostat') {
                            const thermostatStatus = device.status as ThermostatStatus;
                            const oldCurrentTemp = thermostatStatus.currentTemperature;
                            if (
                                oldCurrentTemp === undefined ||
                                Math.abs(oldCurrentTemp - internalTemp) >= 0.5
                            ) {
                                logTemperatures = true;
                            }
                        }
                    });
                }

                if (logTemperatures) {
                    this.log.info(
                        `System temperatures: Internal=${internalTemp}C, External=${externalTemp}C`,
                    );
                }

                if (internalTemp !== undefined) {
                    this.devices.forEach((device: KseniaDevice): void => {
                        if (device.type === 'thermostat') {
                            const thermostatStatus = device.status as ThermostatStatus;
                            const oldCurrentTemp = thermostatStatus.currentTemperature;
                            thermostatStatus.currentTemperature = internalTemp;

                            if (
                                thermostatStatus.targetTemperature === undefined ||
                                thermostatStatus.targetTemperature === null
                            ) {
                                thermostatStatus.targetTemperature = Math.round(internalTemp + 1);
                                this.log.info(
                                    `${device.name}: Initial target temperature set to ${thermostatStatus.targetTemperature}C`,
                                );
                            }

                            if (
                                oldCurrentTemp === undefined ||
                                Math.abs(oldCurrentTemp - internalTemp) >= 0.5
                            ) {
                                this.log.info(
                                    `${device.name}: Current temperature updated to ${internalTemp}C`,
                                );
                            }

                            this.onDeviceStatusUpdate?.(device);
                        }
                    });
                }
            }
        });
    }
}