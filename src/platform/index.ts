import type {
    API,
    Characteristic,
    DynamicPlatformPlugin,
    Logger,
    MatterAccessory,
    PlatformAccessory,
    Service,
} from 'homebridge';

import { MqttBridge } from '../mqtt-bridge';
import { PLUGIN_VERSION_RAW } from '../plugin-version';
import { PLATFORM_NAME, PLUGIN_NAME } from '../settings';
import { initTelemetry, captureError, closeTelemetry } from '../telemetry';
import { tlsConfigurationHint } from '../websocket-client/tls-error-hint';
import type { KseniaDevice } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';
import type { DebugCaptureManager } from '../debug-capture';
import { AccessoryRegistry } from './accessory-registry';
import { AccessoryHandlerService } from './accessory-handler-service';
import { createWebSocketClient, hasConnectionConfig } from './client-options';
import { startRequestedDebugCapture } from './debug-capture-start';
import { MatterAccessoryRegistry } from './matter-accessory-registry';
import { PlatformConfigFileService } from './config-file-service';
import { DeviceListService } from './device-list-service';
import { DeviceEventRouter } from './device-event-router';
import { DiscoveryService } from './discovery-service';
import { KsaImportService } from './ksa-import-service';
import { normalizeMatterRecoveryRequests } from './matter-override-config';
import { PlatformLifecycleService } from './platform-lifecycle-service';
import { SyncLifecycle } from './sync-lifecycle';
import type { AccessoryHandler, Lares4Config } from './types';

export type { AccessoryHandler, Lares4Config, MatterExposureConfig, DeviceListItem, DevicesList } from './types';

export class Lares4Platform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service;
    public readonly Characteristic: typeof Characteristic;
    public readonly accessories: Map<string, PlatformAccessory> = new Map();
    public readonly accessoryHandlers: Map<string, AccessoryHandler> = new Map();

    public wsClient?: KseniaWebSocketClient;
    public mqttBridge?: MqttBridge;

    private readonly activeDiscoveredUUIDs: Set<string> = new Set();
    private readonly accessoryRegistry: AccessoryRegistry;
    private readonly matterRegistry: MatterAccessoryRegistry;
    private readonly discoveryService: DiscoveryService;
    private readonly lifecycleService: PlatformLifecycleService;
    private readonly deviceListService: DeviceListService;
    private readonly handlerService: AccessoryHandlerService;
    private readonly configFileService: PlatformConfigFileService;
    private readonly ksaImportService: KsaImportService;
    private readonly deviceEvents: DeviceEventRouter;
    private readonly syncLifecycle: SyncLifecycle;
    private debugCapture?: DebugCaptureManager;
    /** Set at shutdown: an initialization still in progress must not connect afterwards. */
    private shuttingDown = false;

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
        this.ksaImportService = new KsaImportService(this.log, this.api.user.storagePath(), this.configFileService);
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
            isDeviceExcluded: (device): boolean => this.discoveryService.isDeviceExcluded(device),
        });
        this.matterRegistry = new MatterAccessoryRegistry({
            api: this.api,
            log: this.log,
            getWsClient: () => this.wsClient,
            storagePath: this.api.user.storagePath(),
            momentaryAutoOffMs: this.config?.scenarioAutoOffDelay,
            isDeviceExposed: (device: KseniaDevice): boolean => this.isMatterEligible(device),
            recoveryRequests: normalizeMatterRecoveryRequests(this.config.matterRecoveryRequests),
            unregisterTimeoutMs: this.config.matterUnregisterTimeoutMs,
        });
        this.deviceEvents = new DeviceEventRouter({
            log: this.log,
            discoveryService: this.discoveryService,
            deviceListService: this.deviceListService,
            accessoryRegistry: this.accessoryRegistry,
            matterRegistry: this.matterRegistry,
            getMqttBridge: () => this.mqttBridge,
        });
        this.syncLifecycle = new SyncLifecycle({
            log: this.log,
            accessoryRegistry: this.accessoryRegistry,
            matterRegistry: this.matterRegistry,
            eligibleMatterDevices: (): KseniaDevice[] => [...this.deviceEvents.matterSnapshots]
                .filter((device: KseniaDevice): boolean => this.isMatterEligible(device)),
        });

        if (!hasConnectionConfig(config, this.log)) return;
        // A PIN typed as a number in the JSON editor would escape every string-based mask and scrub.
        this.config.pin = String(config.pin);

        initTelemetry(this.config.telemetry, PLUGIN_VERSION_RAW, [
            this.config.ip,
            this.config.pin,
            this.config.sender,
        ].filter((v): v is string => typeof v === 'string'));

        this.log.debug('Platform initialization completed:', this.config.name);

        this.api.on('didFinishLaunching', (): void => {
            this.log.debug('didFinishLaunching callback executed');
            this.initializeLares4().catch((error: unknown): void => {
                this.log.error('Failed to initialize Lares4:', error instanceof Error ? error.message : String(error));
                captureError(error, { context: 'didFinishLaunching' });
            });
        });
        this.api.on('shutdown', (): void => {
            this.cleanupConnections();
        });
    }

    public configureMatterAccessory(accessory: MatterAccessory): void {
        this.matterRegistry.configureCachedAccessory(accessory);
    }

    private async initializeLares4(): Promise<void> {
        try {
            if (this.initAborted()) return;
            this.log.info('Initializing Ksenia Lares4 connection...');
            this.syncLifecycle.startDiscoveryCycle();

            if (!this.config.ip || !this.config.pin) {
                this.log.error('Configurazione mancante: IP e PIN sono obbligatori');
                return;
            }
            const { ip, pin } = this.config;

            const ksaCache = await this.ksaImportService.prepare(this.config, PLATFORM_NAME);
            // Nothing below awaits until connect(): one check covers the client,
            // the MQTT bridge, the debug capture and the connection.
            if (this.initAborted()) return;

            this.wsClient = createWebSocketClient({ ...this.config, ip, pin }, this.log, ksaCache);

            this.syncLifecycle.attach(this.wsClient, this.deviceEvents);
            // MQTT and debug capture must not depend on the first connect: if the
            // panel is offline at boot, connect() rejects while the client keeps
            // reconnecting in the background.
            if (this.config.mqtt?.enabled) {
                this.mqttBridge = new MqttBridge(this.config.mqtt, this.log, this);
                this.log.info('MQTT Bridge initialized');
            }

            if (this.config.generateDebugFile) {
                this.debugCapture = startRequestedDebugCapture(this.config, this.log, this.api.user.storagePath(), this.wsClient);
                void this.configFileService.disableDebugFlag(PLATFORM_NAME);
            }

            await this.wsClient.connect();

            this.log.info('Ksenia Lares4 initialized successfully');
        } catch (error: unknown) {
            this.log.error('Lares4 initialization error:', error instanceof Error ? error.message : String(error));
            // A TLS failure fixed by allowInsecureTls is a setup issue, already
            // explained in the log by the client: it is not a bug to report.
            const tlsContext = { useHttps: this.config.https !== false, allowInsecureTls: this.config.allowInsecureTls === true };
            if (!tlsConfigurationHint(error, tlsContext)) {
                captureError(error, { context: 'initializeLares4' });
            }
        }
    }

    /**
     * Matter-side eligibility: config exclusions (quiet check) + per-type
     * `matterExposure` opt-out. HAP and MQTT paths are NOT affected by this.
     */
    private isMatterEligible(device: KseniaDevice): boolean {
        // Arming scenarios hidden by the security policy count as not exposed, so a
        // cache-restored endpoint left from an older version is pruned like one of
        // a disabled category.
        if (device.type === 'scenario' && this.wsClient?.isScenarioSuppressed(device.id)) return false;
        return this.discoveryService.resolveMatterPolicy(device).exposed;
    }

    private initAborted(): boolean {
        if (this.shuttingDown) this.log.debug('Initialization stopped: Homebridge is shutting down');
        return this.shuttingDown;
    }

    private cleanupConnections(): void {
        this.shuttingDown = true;
        this.lifecycleService.cleanupConnections((): void => {
            // Flush before disconnecting: both write synchronously, Homebridge exits right after.
            this.debugCapture?.shutdown();
            this.deviceListService.flush();
            this.wsClient?.disconnect();
            this.mqttBridge?.disconnect();
        });
        closeTelemetry();
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
