import type {
    API,
    Characteristic,
    DynamicPlatformPlugin,
    Logger,
    PlatformAccessory,
    PlatformConfig,
    Service,
} from 'homebridge';
import * as fs from 'fs';
import * as path from 'path';

import { getEffectiveLogLevel } from './log-levels';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { KseniaWebSocketClient } from './websocket-client';
import type {
    KseniaDevice,
    KseniaLight,
    KseniaCover,
    KseniaThermostat,
    KseniaSensor,
    KseniaZone,
    KseniaScenario,
    MqttConfig,
    RoomMappingConfig,
} from './types';
import { MqttBridge } from './mqtt-bridge';
import { LightAccessory } from './accessories/light-accessory';
import { CoverAccessory } from './accessories/cover-accessory';
import { SensorAccessory } from './accessories/sensor-accessory';
import { ZoneAccessory } from './accessories/zone-accessory';
import { ThermostatAccessory } from './accessories/thermostat-accessory';
import { ScenarioAccessory } from './accessories/scenario-accessory';

/**
 * Union type for all accessory handlers
 */
export type AccessoryHandler =
    | LightAccessory
    | CoverAccessory
    | SensorAccessory
    | ZoneAccessory
    | ThermostatAccessory
    | ScenarioAccessory;

/**
 * Platform configuration interface
 */
export interface Lares4Config extends PlatformConfig {
    ip?: string;
    sender?: string;
    pin?: string;
    https?: boolean;
    port?: number;
    debug?: boolean;
    logLevel?: number;
    maxSeconds?: number;
    reconnectInterval?: number;
    heartbeatInterval?: number;
    excludeZones?: string[];
    excludeOutputs?: string[];
    excludeSensors?: string[];
    excludeScenarios?: string[];
    customNames?: {
        zones?: Record<string, string>;
        outputs?: Record<string, string>;
        sensors?: Record<string, string>;
        scenarios?: Record<string, string>;
    };
    scenarioAutoOffDelay?: number;
    coverStepSize?: number;
    temperatureDefaults?: {
        target?: number;
        min?: number;
        max?: number;
        step?: number;
    };
    devicesSummaryDelay?: number;
    mqtt?: MqttConfig;
    roomMapping?: RoomMappingConfig;
}

/**
 * Device list structure for configuration UI
 */
interface DeviceListItem {
    id: string;
    name: string;
    type: string;
    description: string;
    fullId: string;
}

interface DevicesList {
    zones: DeviceListItem[];
    outputs: DeviceListItem[];
    sensors: DeviceListItem[];
    scenarios: DeviceListItem[];
    lastUpdated: string;
}

/**
 * Main platform class implementing DynamicPlatformPlugin
 */
export class Lares4Platform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service;
    public readonly Characteristic: typeof Characteristic;

    public readonly accessories: Map<string, PlatformAccessory> = new Map();
    public readonly discoveredCacheUUIDs: string[] = [];

    public readonly accessoryHandlers: Map<string, AccessoryHandler> = new Map();

    public wsClient?: KseniaWebSocketClient;
    public mqttBridge?: MqttBridge;

    private readonly discoveredDevices: Map<string, KseniaDevice> = new Map();
    private readonly devicesFilePath: string;
    private summaryTimeout?: NodeJS.Timeout;

    constructor(
        public readonly log: Logger,
        public readonly config: Lares4Config,
        public readonly api: API,
    ) {
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;

        this.devicesFilePath = path.join(this.api.user.storagePath(), 'klares4-devices.json');

        if (!config) {
            this.log.error('No configuration found');
            return;
        }

        if (!config.ip) {
            this.log.error('IP address missing in configuration');
            return;
        }

        if (!config.pin) {
            this.log.error('PIN missing in configuration');
            return;
        }

        this.log.debug('Platform initialization completed:', this.config.name);

        this.api.on('didFinishLaunching', (): void => {
            this.log.debug('didFinishLaunching callback executed');
            this.initializeLares4().catch((error: unknown): void => {
                this.log.error(
                    'Failed to initialize Lares4:',
                    error instanceof Error ? error.message : String(error),
                );
            });
        });
    }

    private async initializeLares4(): Promise<void> {
        try {
            this.log.info('Initializing Ksenia Lares4 connection...');

            const useHttps = this.config.https !== false;
            const port = this.config.port ?? (useHttps ? 443 : 80);

            if (!this.config.ip || !this.config.pin) {
                this.log.error('Configurazione mancante: IP e PIN sono obbligatori');
                return;
            }

            this.wsClient = new KseniaWebSocketClient(
                this.config.ip!,
                port,
                useHttps,
                this.config.sender ?? 'homebridge',
                this.config.pin!,
                this.log,
                {
                    debug: this.config.debug ?? false,
                    logLevel: getEffectiveLogLevel(this.config.logLevel, this.config.debug),
                    reconnectInterval: this.config.reconnectInterval ?? 5000,
                    heartbeatInterval: this.config.heartbeatInterval ?? 30000,
                },
            );

            this.wsClient.onDeviceDiscovered = (device: KseniaDevice): void => {
                this.handleDeviceDiscovered(device);
            };
            this.wsClient.onDeviceStatusUpdate = (device: KseniaDevice): void => {
                this.handleDeviceStatusUpdate(device);
            };

            await this.wsClient.connect();

            if (this.config.mqtt?.enabled) {
                this.mqttBridge = new MqttBridge(this.config.mqtt, this.log, this);
                this.log.info('MQTT Bridge initialized');
            }

            this.log.info('Ksenia Lares4 initialized successfully');
        } catch (error: unknown) {
            this.log.error(
                'Lares4 initialization error:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private handleDeviceDiscovered(device: KseniaDevice): void {
        this.discoveredDevices.set(device.id, device);
        this.saveDevicesList();

        if (this.shouldExcludeDevice(device)) {
            this.log.info(`Device excluded: ${device.type} - ${device.name}`);
            return;
        }

        const customName = this.getCustomName(device);
        if (customName) {
            const mutableDevice = device as { name: string; description: string };
            mutableDevice.name = customName;
            mutableDevice.description = customName;
        }

        this.log.info(`Device discovered: ${device.type} - ${device.name}`);
        this.addAccessory(device);
    }

    private saveDevicesList(): void {
        try {
            const devicesList: DevicesList = {
                zones: [],
                outputs: [],
                sensors: [],
                scenarios: [],
                lastUpdated: new Date().toISOString(),
            };

            for (const device of this.discoveredDevices.values()) {
                const id = device.id.replace(
                    /^(light_|cover_|sensor_temp_|sensor_hum_|sensor_light_|zone_|thermostat_|scenario_)/,
                    '',
                );

                const deviceInfo: DeviceListItem = {
                    id: id,
                    name: device.name,
                    type: device.type,
                    description: device.description || device.name,
                    fullId: device.id,
                };

                if (device.type === 'zone') {
                    devicesList.zones.push(deviceInfo);
                } else if (
                    device.type === 'light' ||
                    device.type === 'cover' ||
                    device.type === 'thermostat'
                ) {
                    devicesList.outputs.push(deviceInfo);
                } else if (device.type === 'sensor') {
                    devicesList.sensors.push(deviceInfo);
                } else if (device.type === 'scenario') {
                    devicesList.scenarios.push(deviceInfo);
                }
            }

            devicesList.zones.sort((a, b) => a.name.localeCompare(b.name));
            devicesList.outputs.sort((a, b) => a.name.localeCompare(b.name));
            devicesList.sensors.sort((a, b) => a.name.localeCompare(b.name));
            devicesList.scenarios.sort((a, b) => a.name.localeCompare(b.name));

            fs.writeFileSync(this.devicesFilePath, JSON.stringify(devicesList, null, 2));
            this.log.debug(`Devices list saved: ${this.discoveredDevices.size} devices`);

            if (this.summaryTimeout) {
                clearTimeout(this.summaryTimeout);
            }
            const summaryDelay = this.config.devicesSummaryDelay ?? 2000;
            this.summaryTimeout = setTimeout((): void => {
                this.printDevicesSummary(devicesList);
                this.summaryTimeout = undefined;
            }, summaryDelay);
        } catch (error: unknown) {
            this.log.error(
                'Error saving devices list:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private printDevicesSummary(devicesList: DevicesList): void {
        this.log.info('');
        this.log.info('========== AVAILABLE DEVICES ==========');
        this.log.info('Use the following IDs to exclude devices or configure MQTT rooms:');
        this.log.info('');

        if (devicesList.outputs.length > 0) {
            this.log.info('OUTPUTS (Lights, Covers, Thermostats):');
            devicesList.outputs.forEach((device: DeviceListItem): void => {
                const typeLabel =
                    device.type === 'thermostat'
                        ? 'THERM'
                        : device.type === 'light'
                            ? 'LIGHT'
                            : 'COVER';
                this.log.info(`   ID: ${device.fullId.padEnd(20)} - [${typeLabel}] ${device.name}`);
            });
            this.log.info('');
        }

        if (devicesList.zones.length > 0) {
            this.log.info('ZONES (Security Sensors):');
            devicesList.zones.forEach((device: DeviceListItem): void => {
                this.log.info(`   ID: ${device.fullId.padEnd(20)} - [ZONE] ${device.name}`);
            });
            this.log.info('');
        }

        if (devicesList.sensors.length > 0) {
            this.log.info('SENSORS (Temperature, Humidity, Light):');
            devicesList.sensors.forEach((device: DeviceListItem): void => {
                let typeLabel = 'SENSOR';
                if (device.name.includes('Temperatura')) {
                    typeLabel = 'TEMP';
                } else if (device.name.includes('Umidita')) {
                    typeLabel = 'HUM';
                } else if (device.name.includes('Luminosita')) {
                    typeLabel = 'LUX';
                }
                this.log.info(`   ID: ${device.fullId.padEnd(20)} - [${typeLabel}] ${device.name}`);
            });
            this.log.info('');
        }

        if (devicesList.scenarios.length > 0) {
            this.log.info('SCENARIOS (Automations):');
            devicesList.scenarios.forEach((device: DeviceListItem): void => {
                this.log.info(`   ID: ${device.fullId.padEnd(20)} - [SCENE] ${device.name}`);
            });
            this.log.info('');
        }

        this.log.info('Full list saved to: ' + this.devicesFilePath);
        this.log.info('Use these IDs in configuration to exclude devices');
        this.log.info('Or to configure MQTT rooms in Homebridge UI');
        this.log.info('================================================');
        this.log.info('');

        this.generateRoomMappingExample(devicesList);
    }

    private generateRoomMappingExample(devicesList: DevicesList): void {
        try {
            const examplePath = path.join(
                this.api.user.storagePath(),
                'klares4-room-mapping-example.json',
            );

            const exampleConfig = {
                roomMapping: {
                    enabled: false,
                    rooms: [
                        {
                            roomName: 'sala',
                            devices: this.getExampleDevicesForRoom(devicesList, 'sala'),
                        },
                        {
                            roomName: 'cucina',
                            devices: this.getExampleDevicesForRoom(devicesList, 'cucina'),
                        },
                        {
                            roomName: 'camera',
                            devices: this.getExampleDevicesForRoom(devicesList, 'camera'),
                        },
                    ],
                },
                _note: 'This is an example file. Modify roomName and devices as needed.',
                _availableDevices: {
                    outputs: devicesList.outputs.map((d: DeviceListItem) => ({
                        id: d.fullId,
                        name: d.name,
                        type: d.type,
                    })),
                    zones: devicesList.zones.map((d: DeviceListItem) => ({
                        id: d.fullId,
                        name: d.name,
                        type: d.type,
                    })),
                    sensors: devicesList.sensors.map((d: DeviceListItem) => ({
                        id: d.fullId,
                        name: d.name,
                        type: d.type,
                    })),
                    scenarios: devicesList.scenarios.map((d: DeviceListItem) => ({
                        id: d.fullId,
                        name: d.name,
                        type: d.type,
                    })),
                },
            };

            fs.writeFileSync(examplePath, JSON.stringify(exampleConfig, null, 2));
            this.log.info(`Room mapping example created: ${examplePath}`);
        } catch (error: unknown) {
            this.log.error(
                'Error creating example file:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private getExampleDevicesForRoom(
        devicesList: DevicesList,
        roomName: string,
    ): Array<{ deviceId: string; deviceName: string }> {
        const devices: Array<{ deviceId: string; deviceName: string }> = [];

        switch (roomName) {
            case 'sala': {
                const salaDevices = [
                    ...devicesList.sensors.slice(0, 2),
                    ...devicesList.outputs.slice(0, 1),
                ];
                salaDevices.forEach((device: DeviceListItem): void => {
                    devices.push({
                        deviceId: device.fullId,
                        deviceName: device.name,
                    });
                });
                break;
            }
            case 'cucina': {
                const cucinaDevices = [...devicesList.outputs.slice(1, 3)];
                cucinaDevices.forEach((device: DeviceListItem): void => {
                    devices.push({
                        deviceId: device.fullId,
                        deviceName: device.name,
                    });
                });
                break;
            }
            case 'camera': {
                const cameraDevices = [
                    ...devicesList.zones.slice(0, 1),
                    ...devicesList.outputs.slice(3, 4),
                ];
                cameraDevices.forEach((device: DeviceListItem): void => {
                    devices.push({
                        deviceId: device.fullId,
                        deviceName: device.name,
                    });
                });
                break;
            }
        }

        return devices.slice(0, 3);
    }

    private shouldExcludeDevice(device: KseniaDevice): boolean {
        const id = device.id.replace(
            /^(light_|cover_|sensor_temp_|sensor_hum_|sensor_light_|zone_|thermostat_|scenario_)/,
            '',
        );

        if (device.type === 'zone' && this.config.excludeZones?.includes(id)) {
            this.log.info(`Zone excluded: ${device.name} (ID: ${id})`);
            return true;
        }
        if (
            (device.type === 'light' ||
                device.type === 'cover' ||
                device.type === 'thermostat') &&
            this.config.excludeOutputs?.includes(id)
        ) {
            this.log.info(`Output excluded: ${device.name} (ID: ${id})`);
            return true;
        }
        if (device.type === 'sensor' && this.config.excludeSensors?.includes(id)) {
            this.log.info(`Sensor excluded: ${device.name} (ID: ${id})`);
            return true;
        }
        if (device.type === 'scenario' && this.config.excludeScenarios?.includes(id)) {
            this.log.info(`Scenario excluded: ${device.name} (ID: ${id})`);
            return true;
        }

        return false;
    }

    private getCustomName(device: KseniaDevice): string | undefined {
        const id = device.id.replace(
            /^(light_|cover_|sensor_temp_|sensor_hum_|sensor_light_|zone_|thermostat_|scenario_)/,
            '',
        );

        if (device.type === 'zone') {
            return this.config.customNames?.zones?.[id];
        }
        if (device.type === 'light' || device.type === 'cover' || device.type === 'thermostat') {
            return this.config.customNames?.outputs?.[id];
        }
        if (device.type === 'sensor') {
            const sensorName = this.config.customNames?.sensors?.[id];
            if (sensorName) {
                if (device.id.includes('_temp_')) return `${sensorName} - Temperatura`;
                if (device.id.includes('_hum_')) return `${sensorName} - Umidita`;
                if (device.id.includes('_light_')) return `${sensorName} - Luminosita`;
            }
        }
        if (device.type === 'scenario') {
            return this.config.customNames?.scenarios?.[id];
        }

        return undefined;
    }

    private handleDeviceStatusUpdate(device: KseniaDevice): void {
        this.log.debug(`Device status update: ${device.name}`);
        this.updateAccessory(device);

        if (this.mqttBridge) {
            this.mqttBridge.publishDeviceState(device);
        }
    }

    public configureAccessory(accessory: PlatformAccessory): void {
        this.log.info('Loading accessory from cache:', accessory.displayName);
        this.accessories.set(accessory.UUID, accessory);
    }

    public addAccessory(device: KseniaDevice): void {
        const uuid = this.api.hap.uuid.generate(device.id);
        const existingAccessory = this.accessories.get(uuid);

        if (existingAccessory) {
            this.log.info('Restoring existing accessory from cache:', device.name);
            existingAccessory.context.device = device;
            this.createAccessoryHandler(existingAccessory, device);
        } else {
            this.log.info('Adding new accessory:', device.name);
            const accessory = new this.api.platformAccessory(device.name, uuid);
            accessory.context.device = device;
            this.createAccessoryHandler(accessory, device);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.accessories.set(uuid, accessory);
        }
    }

    public updateAccessory(device: KseniaDevice): void {
        const uuid = this.api.hap.uuid.generate(device.id);
        const accessory = this.accessories.get(uuid);
        const handler = this.accessoryHandlers.get(uuid);

        if (accessory && handler) {
            accessory.context.device = device;

            if ('updateStatus' in handler && typeof handler.updateStatus === 'function') {
                switch (device.type) {
                    case 'light':
                        (handler as LightAccessory).updateStatus(device as KseniaLight);
                        break;
                    case 'cover':
                        (handler as CoverAccessory).updateStatus(device as KseniaCover);
                        break;
                    case 'thermostat':
                        (handler as ThermostatAccessory).updateStatus(device as KseniaThermostat);
                        break;
                    case 'sensor':
                        (handler as SensorAccessory).updateStatus(device as KseniaSensor);
                        break;
                    case 'zone':
                        (handler as ZoneAccessory).updateStatus(device as KseniaZone);
                        break;
                    case 'scenario':
                        break;
                }
            }
        }
    }

    private createAccessoryHandler(accessory: PlatformAccessory, device: KseniaDevice): void {
        const uuid = accessory.UUID;

        if (this.accessoryHandlers.has(uuid)) {
            this.accessoryHandlers.delete(uuid);
        }

        let handler: AccessoryHandler | undefined;

        switch (device.type) {
            case 'light':
                handler = new LightAccessory(this, accessory);
                this.log.debug(`Created handler for light: ${device.name}`);
                break;
            case 'cover':
                handler = new CoverAccessory(this, accessory);
                this.log.debug(`Created handler for cover: ${device.name}`);
                break;
            case 'sensor':
                handler = new SensorAccessory(this, accessory);
                this.log.debug(`Created handler for sensor: ${device.name}`);
                break;
            case 'zone':
                handler = new ZoneAccessory(this, accessory);
                this.log.debug(`Created handler for zone: ${device.name}`);
                break;
            case 'thermostat':
                handler = new ThermostatAccessory(this, accessory);
                this.log.debug(`Created handler for thermostat: ${device.name}`);
                break;
            case 'scenario':
                handler = new ScenarioAccessory(this, accessory, device as KseniaScenario);
                this.log.debug(`Created handler for scenario: ${device.name}`);
                break;
            default:
                this.log.warn(`Unsupported device type: ${(device as KseniaDevice).type}`);
                return;
        }

        if (handler) {
            this.accessoryHandlers.set(uuid, handler);
        }
    }

    public removeAccessory(accessory: PlatformAccessory): void {
        this.log.info('Removing accessory:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(accessory.UUID);
    }
}