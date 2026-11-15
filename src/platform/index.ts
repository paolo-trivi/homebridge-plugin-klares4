import type {
    API,
    Characteristic,
    DynamicPlatformPlugin,
    Logger,
    MatterAccessory,
    PlatformAccessory,
    Service,
} from 'homebridge';

import { createLeveledLogger } from '../leveled-logger';
import { MqttBridge } from '../mqtt-bridge';
import { PLATFORM_NAME, PLUGIN_NAME } from '../settings';
import type { KseniaDevice } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';
import type { DebugCaptureManager } from '../debug-capture';
import { AccessoryRegistry } from './accessory-registry';
import { AccessoryHandlerService } from './accessory-handler-service';
import { clientExposurePolicy, createWebSocketClient, hasConnectionConfig } from './client-options';
import { startRequestedDebugCapture } from './debug-capture-start';
import { MatterAccessoryRegistry } from './matter-accessory-registry';
import { PlatformConfigFileService, type PlatformBlockSelector } from './config-file-service';
import { DeviceListService } from './device-list-service';
import { DeviceEventRouter } from './device-event-router';
import { DiscoveryService } from './discovery-service';
import { KsaImportService } from './ksa-import-service';
import { reportConfigOverrides } from './override-reconciliation';
import { PlatformLifecycleService } from './platform-lifecycle-service';
import { refreshKsaSections, reportDeprecatedKeys, resolveRuntimeConfig, toPlatformConfig, type RuntimeConfig } from './runtime-config';
import { SyncLifecycle } from './sync-lifecycle';
import type { AccessoryHandler, Lares4Config, RawLares4Config } from './types';
import { toErrorMessage } from '../errors';

export type { AccessoryHandler, Lares4Config, MatterExposureConfig, DeviceListItem, DevicesList, RawLares4Config } from './types';
export type { RuntimeConfig } from './runtime-config';

export class Lares4Platform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service;
    public readonly Characteristic: typeof Characteristic;
    public readonly accessories: Map<string, PlatformAccessory> = new Map();
    public readonly accessoryHandlers: Map<string, AccessoryHandler> = new Map();
    /** The user's config with every key this plugin reads already validated (see `runtimeConfig`). */
    public readonly config: Lares4Config;

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
    private runtime: RuntimeConfig;
    private debugCapture?: DebugCaptureManager;
    /** Set at shutdown: an initialization still in progress must not connect afterwards. */
    private shuttingDown = false;

    /** Homebridge's logger held to the configured `logLevel`: every service logs through it. */
    public readonly log: Logger;

    constructor(
        log: Logger,
        config: RawLares4Config,
        public readonly api: API,
    ) {
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        // The only place the raw config is interpreted: problems are logged here, once.
        this.runtime = resolveRuntimeConfig(config, log);
        this.log = createLeveledLogger(log, this.runtime.logLevel);
        reportDeprecatedKeys(config, this.log);
        this.config = toPlatformConfig(config, this.runtime);
        this.discoveryService = new DiscoveryService(this.config, this.log, this.runtime);
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
            momentaryAutoOffMs: this.runtime.scenarioAutoOffDelay,
            isDeviceExposed: (device: KseniaDevice): boolean => this.isMatterEligible(device),
            recoveryRequests: this.runtime.matterRecoveryRequests,
            unregisterTimeoutMs: this.runtime.matterUnregisterTimeoutMs,
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
            onFirstSyncComplete: (discoveredIds: ReadonlySet<string>): void =>
                reportConfigOverrides(this.runtime, discoveredIds, this.log),
            onPanelConnection: (connected: boolean): void => this.mqttBridge?.setPanelConnected(connected),
        });

        if (!hasConnectionConfig(config, this.runtime, this.log)) return;

        this.log.debug('Platform initialization completed:', this.config.name);

        this.api.on('didFinishLaunching', (): void => {
            this.log.debug('didFinishLaunching callback executed');
            this.initializeLares4().catch((error: unknown): void => {
                this.log.error('Failed to initialize Lares4:', toErrorMessage(error));
            });
        });
        this.api.on('shutdown', (): void => {
            this.cleanupConnections();
        });
    }

    /** Validated config with nothing optional where a default exists; prefer it to `config`. */
    public get runtimeConfig(): RuntimeConfig {
        return this.runtime;
    }

    public configureMatterAccessory(accessory: MatterAccessory): void {
        this.matterRegistry.configureCachedAccessory(accessory);
    }

    private async initializeLares4(): Promise<void> {
        try {
            if (this.initAborted()) return;
            this.log.info('Initializing Ksenia Lares4 connection...');

            if (!this.runtime.ip || !this.runtime.pin) {
                this.log.error('Configuration missing: IP and PIN are required');
                return;
            }

            // The first thing a start does with the storage directory: clear what a crashed write left.
            await this.configFileService.removeOrphanedTemporaryFiles();
            if (this.initAborted()) return;

            const ksaCache = await this.ksaImportService.prepare(this.config, PLATFORM_NAME);
            // Nothing below awaits until connect(): one check covers the client,
            // the MQTT bridge, the debug capture and the connection.
            if (this.initAborted()) return;

            // The KSA import may have replaced mappings in `this.config`: read those sections back.
            this.runtime = refreshKsaSections(this.runtime, this.config, this.log);
            const { ip, pin } = this.runtime;
            if (!ip || !pin) return;
            this.wsClient = createWebSocketClient({ ...this.runtime, ip, pin }, this.log, ksaCache);
            // A cached accessory of a device the exposure policy now hides is treated as excluded.
            this.discoveryService.attachExposurePolicy(clientExposurePolicy(this.wsClient));

            // MQTT and debug capture must not depend on the first connect: if the
            // panel is offline at boot, connect() rejects while the client keeps
            // reconnecting in the background. The bridge exists before `attach`,
            // which reports the panel as not connected yet.
            if (this.runtime.mqtt?.enabled) {
                this.mqttBridge = new MqttBridge(this.runtime.mqtt, this.log, this, {
                    isDeviceExcluded: (device: KseniaDevice): boolean => this.discoveryService.isDeviceExcluded(device),
                });
                this.log.info('MQTT Bridge initialized');
            }
            this.syncLifecycle.attach(this.wsClient, this.deviceEvents);

            if (this.runtime.generateDebugFile) {
                this.debugCapture = startRequestedDebugCapture(this.runtime.debugCaptureDurationMs, this.log, this.api.user.storagePath(), this.wsClient);
                void this.configFileService.disableDebugFlag(PLATFORM_NAME, this.blockSelector());
            }

            await this.wsClient.connect();

            this.log.info('Ksenia Lares4 initialized successfully');
        } catch (error: unknown) {
            this.log.error('Lares4 initialization error:', toErrorMessage(error));
        }
    }

    /**
     * Matter-side eligibility: config exclusions (quiet check) + per-type
     * `matterExposure` opt-out. HAP and MQTT paths are NOT affected by this.
     */
    private isMatterEligible(device: KseniaDevice): boolean {
        // Devices the exposure policy hides (arming scenarios included) count as
        // excluded in `resolveMatterPolicy`, so a cache-restored endpoint left
        // from an older version is pruned like one of a disabled category.
        return this.discoveryService.resolveMatterPolicy(device).exposed;
    }

    /** What tells this instance's block apart in config.json when it holds several. */
    private blockSelector(): PlatformBlockSelector {
        return { name: this.config.name, ip: this.runtime.ip };
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
