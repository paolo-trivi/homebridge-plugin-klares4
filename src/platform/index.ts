import type {
    API,
    Characteristic,
    DynamicPlatformPlugin,
    Logger,
    PlatformAccessory,
    Service,
} from 'homebridge';

import { getEffectiveLogLevel } from '../log-levels';
import { MqttBridge } from '../mqtt-bridge';
import { PLATFORM_NAME, PLUGIN_NAME } from '../settings';
import type { KseniaDevice } from '../types';
import { KseniaWebSocketClient } from '../websocket-client';
import { DebugCaptureManager } from '../debug-capture';
import { AccessoryRegistry } from './accessory-registry';
import { AccessoryHandlerService } from './accessory-handler-service';
import { PlatformConfigFileService } from './config-file-service';
import { DeviceListService } from './device-list-service';
import { DiscoveryService } from './discovery-service';
import { PlatformLifecycleService } from './platform-lifecycle-service';
import type { AccessoryHandler, Lares4Config } from './types';

export type { AccessoryHandler, Lares4Config, DeviceListItem, DevicesList } from './types';

export class Lares4Platform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service;
    public readonly Characteristic: typeof Characteristic;
    public readonly accessories: Map<string, PlatformAccessory> = new Map();
    public readonly accessoryHandlers: Map<string, AccessoryHandler> = new Map();

    public wsClient?: KseniaWebSocketClient;
    public mqttBridge?: MqttBridge;

    private readonly discoveredDevices: Map<string, KseniaDevice> = new Map();
    private readonly activeDiscoveredUUIDs: Set<string> = new Set();
    private readonly accessoryRegistry: AccessoryRegistry;
    private readonly discoveryService: DiscoveryService;
    private readonly lifecycleService: PlatformLifecycleService;
    private readonly deviceListService: DeviceListService;
    private readonly handlerService: AccessoryHandlerService;
    private readonly configFileService: PlatformConfigFileService;

    constructor(
        public readonly log: Logger,
        public readonly config: Lares4Config,
        public readonly api: API,
    ) {
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.discoveryService = new DiscoveryService(this.config, this.log);
        this.lifecycleService = new PlatformLifecycleService(this.log);
        this.deviceListService = new DeviceListService({
            log: this.log,
            storagePath: this.api.user.storagePath(),
            config: this.config,
            discoveryService: this.discoveryService,
            lifecycleService: this.lifecycleService,
        });
        this.handlerService = new AccessoryHandlerService(this, this.log);
        this.configFileService = new PlatformConfigFileService(this.log, this.api.user.storagePath());
        this.accessoryRegistry = new AccessoryRegistry({
            api: this.api,
            log: this.log,
            pluginName: PLUGIN_NAME,
            platformName: PLATFORM_NAME,
            accessories: this.accessories,
            accessoryHandlers: this.accessoryHandlers,
            activeDiscoveredUUIDs: this.activeDiscoveredUUIDs,
            createAccessoryHandler: (accessory, device): AccessoryHandler | undefined =>
                this.handlerService.createAccessoryHandler(accessory, device),
            updateAccessoryHandler: (handler, device): void =>
                this.handlerService.updateAccessoryHandler(handler, device),
        });

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
        this.api.on('shutdown', (): void => {
            this.cleanupConnections();
        });
    }

    private async initializeLares4(): Promise<void> {
        try {
            this.log.info('Initializing Ksenia Lares4 connection...');
            this.accessoryRegistry.startDiscoveryCycle();

            const useHttps = this.config.https !== false;
            const port = this.config.port ?? (useHttps ? 443 : 80);
            if (!this.config.ip || !this.config.pin) {
                this.log.error('Configurazione mancante: IP e PIN sono obbligatori');
                return;
            }

            this.wsClient = new KseniaWebSocketClient(
                this.config.ip,
                port,
                useHttps,
                this.config.sender ?? 'homebridge',
                this.config.pin,
                this.log,
                {
                    debug: this.config.debug ?? false,
                    logLevel: getEffectiveLogLevel(this.config.logLevel, this.config.debug),
                    reconnectInterval: this.config.reconnectInterval ?? 5000,
                    heartbeatInterval: this.config.heartbeatInterval ?? 30000,
                    commandTimeoutMs: this.config.commandTimeoutMs ?? 8000,
                    allowInsecureTls: this.config.allowInsecureTls ?? false,
                },
            );

            if (this.config.allowInsecureTls) {
                this.log.warn(
                    'TLS certificate verification is disabled (allowInsecureTls=true). Use only on trusted local networks.',
                );
            }

            this.wsClient.onDeviceDiscovered = (device: KseniaDevice): void => {
                this.handleDeviceDiscovered(device);
            };
            this.wsClient.onDeviceStatusUpdate = (device: KseniaDevice): void => {
                this.handleDeviceStatusUpdate(device);
            };
            this.wsClient.onInitialSyncComplete = (): void => {
                this.handleInitialSyncComplete();
            };
            await this.wsClient.connect();

            if (this.config.mqtt?.enabled) {
                this.mqttBridge = new MqttBridge(this.config.mqtt, this.log, this);
                this.log.info('MQTT Bridge initialized');
            }

            if (this.config.generateDebugFile) {
                this.log.warn('[DEBUG] Debug capture requested - starting 60-second capture...');
                const debugCapture = new DebugCaptureManager(this.log, this.api.user.storagePath());
                debugCapture.startCapture(this.wsClient, 60000);
                void this.configFileService.disableDebugFlag(PLATFORM_NAME);
            }

            this.log.info('Ksenia Lares4 initialized successfully');
        } catch (error: unknown) {
            this.log.error(
                'Lares4 initialization error:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private handleInitialSyncComplete(): void {
        this.log.info('Initial synchronization completed, pruning stale accessories...');
        this.accessoryRegistry.pruneStaleAccessories();
    }

    private cleanupConnections(): void {
        this.lifecycleService.cleanupConnections((): void => {
            this.wsClient?.disconnect();
            this.mqttBridge?.disconnect();
        });
    }

    private handleDeviceDiscovered(device: KseniaDevice): void {
        this.discoveredDevices.set(device.id, device);
        this.deviceListService.saveDevicesList(this.discoveredDevices.values());

        if (this.discoveryService.shouldExcludeDevice(device)) {
            this.log.info(`Device excluded: ${device.type} - ${device.name}`);
            return;
        }

        this.discoveryService.applyCustomName(device);
        this.log.info(`Device discovered: ${device.type} - ${device.name}`);
        this.addAccessory(device);
    }

    private handleDeviceStatusUpdate(device: KseniaDevice): void {
        this.log.debug(`Device status update: ${device.name}`);
        this.updateAccessory(device);
        this.mqttBridge?.publishDeviceState(device);
    }

    public configureAccessory(accessory: PlatformAccessory): void {
        this.accessoryRegistry.configureAccessory(accessory);
    }

    public addAccessory(device: KseniaDevice): void {
        this.accessoryRegistry.addAccessory(device);
    }

    public updateAccessory(device: KseniaDevice): void {
        this.accessoryRegistry.updateAccessory(device);
    }

    public removeAccessory(accessory: PlatformAccessory): void {
        this.accessoryRegistry.removeAccessory(accessory);
    }
}
