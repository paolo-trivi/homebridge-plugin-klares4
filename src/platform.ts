import type {
    API,
    Characteristic,
    DynamicPlatformPlugin,
    Logger,
    PlatformAccessory,
    PlatformConfig,
    Service
} from 'homebridge';
import * as fs from 'fs';
import * as path from 'path';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { KseniaWebSocketClient } from './websocket-client';
import { KseniaDevice } from './types';
import { LightAccessory } from './accessories/light-accessory';
import { CoverAccessory } from './accessories/cover-accessory';
import { SensorAccessory } from './accessories/sensor-accessory';
import { ZoneAccessory } from './accessories/zone-accessory';
import { ThermostatAccessory } from './accessories/thermostat-accessory';
import { ScenarioAccessory } from './accessories/scenario-accessory';

export interface Lares4Config extends PlatformConfig {
    ip?: string;
    sender?: string;
    pin?: string;
    https?: boolean;
    port?: number;
    debug?: boolean;
    maxSeconds?: number;
    reconnectInterval?: number;
    heartbeatInterval?: number;
    excludeZones?: string[];
    excludeOutputs?: string[];
    excludeSensors?: string[];
    excludeScenarios?: string[];
    customNames?: {
        zones?: { [id: string]: string };
        outputs?: { [id: string]: string };
        sensors?: { [id: string]: string };
        scenarios?: { [id: string]: string };
    };
    // Nuovi parametri configurabili
    scenarioAutoOffDelay?: number;        // Timeout auto-spegnimento scenari (default 500ms)
    coverStepSize?: number;               // Dimensione step simulazione tapparelle (default 5%)
    temperatureDefaults?: {
        target?: number;                  // Temperatura target default termostati (default 21°C)
        min?: number;                     // Temperatura minima termostati (default 10°C)
        max?: number;                     // Temperatura massima termostati (default 38°C)
        step?: number;                    // Step temperatura termostati (default 0.5°C)
    };
    devicesSummaryDelay?: number;         // Ritardo stampa riassunto dispositivi (default 2000ms)
}

export class Lares4Platform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service;
    public readonly Characteristic: typeof Characteristic;

    public readonly accessories: Map<string, PlatformAccessory> = new Map();
    public readonly discoveredCacheUUIDs: string[] = [];

    // Map per tenere traccia degli handlers degli accessori
    private readonly accessoryHandlers: Map<string, any> = new Map();

    public wsClient?: KseniaWebSocketClient;

    // Cache dei dispositivi per la configurazione UI
    private discoveredDevices: Map<string, KseniaDevice> = new Map();
    private devicesFilePath: string;
    private summaryTimeout?: NodeJS.Timeout;

    constructor(
        public readonly log: Logger,
        public readonly config: Lares4Config,
        public readonly api: API,
    ) {
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;

        // Percorso per salvare la lista dei dispositivi
        this.devicesFilePath = path.join(this.api.user.storagePath(), 'klares4-devices.json');

        if (!config) {
            this.log.error('❌ Nessuna configurazione trovata');
            return;
        }

        if (!config.ip) {
            this.log.error('❌ Indirizzo IP mancante nella configurazione');
            return;
        }

        if (!config.pin) {
            this.log.error('❌ PIN mancante nella configurazione');
            return;
        }

        this.log.debug('🔧 Inizializzazione platform completata:', this.config.name);

        this.api.on('didFinishLaunching', async () => {
            this.log.debug('🚀 Callback didFinishLaunching eseguito');
            await this.initializeLares4();
        });
    }

    private async initializeLares4(): Promise<void> {
        try {
            this.log.info('🔌 Inizializzazione connessione Ksenia Lares4...');

            const useHttps = this.config.https !== false; // Default true
            const port = this.config.port || (useHttps ? 443 : 80);

            if (!this.config.ip || !this.config.pin) {
                this.log.error('Configurazione mancante: IP e PIN sono obbligatori');
                return;
            }

            this.wsClient = new KseniaWebSocketClient(
                this.config.ip,
                port,
                useHttps,
                this.config.sender || 'homebridge',
                this.config.pin,
                this.log,
                {
                    debug: this.config.debug || false,
                    reconnectInterval: this.config.reconnectInterval || 5000,
                    heartbeatInterval: this.config.heartbeatInterval || 30000
                }
            );

            // Setup event handlers
            this.wsClient.onDeviceDiscovered = (device) => this.handleDeviceDiscovered(device);
            this.wsClient.onDeviceStatusUpdate = (device) => this.handleDeviceStatusUpdate(device);

            await this.wsClient.connect();

            this.log.info('✅ Ksenia Lares4 inizializzato con successo');

        } catch (error) {
            this.log.error('❌ Errore inizializzazione Lares4:', error);
        }
    }

    private handleDeviceDiscovered(device: KseniaDevice): void {
        // Aggiungi il dispositivo alla cache per la UI di configurazione
        this.discoveredDevices.set(device.id, device);

        // Salva la lista aggiornata dei dispositivi
        this.saveDevicesList();

        // Controlla se il dispositivo deve essere escluso
        if (this.shouldExcludeDevice(device)) {
            this.log.info(`⏭️ Dispositivo escluso: ${device.type} - ${device.name}`);
            return;
        }

        // Applica nome personalizzato se presente
        const customName = this.getCustomName(device);
        if (customName) {
            device.name = customName;
            device.description = customName;
        }

        this.log.info(`🔍 Dispositivo scoperto: ${device.type} - ${device.name}`);
        this.addAccessory(device);
    }

    private saveDevicesList(): void {
        try {
            const devicesList = {
                zones: [] as any[],
                outputs: [] as any[],
                sensors: [] as any[],
                scenarios: [] as any[],
                lastUpdated: new Date().toISOString()
            };

            for (const device of this.discoveredDevices.values()) {
                const id = device.id.replace(/^(light_|cover_|sensor_temp_|sensor_hum_|sensor_light_|zone_|thermostat_|scenario_)/, '');

                const deviceInfo = {
                    id: id,
                    name: device.name,
                    type: device.type,
                    description: device.description || device.name,
                    fullId: device.id
                };

                if (device.type === 'zone') {
                    devicesList.zones.push(deviceInfo);
                } else if (device.type === 'light' || device.type === 'cover' || device.type === 'thermostat') {
                    devicesList.outputs.push(deviceInfo);
                } else if (device.type === 'sensor') {
                    devicesList.sensors.push(deviceInfo);
                } else if (device.type === 'scenario') {
                    devicesList.scenarios.push(deviceInfo);
                }
            }

            // Ordina per nome
            devicesList.zones.sort((a, b) => a.name.localeCompare(b.name));
            devicesList.outputs.sort((a, b) => a.name.localeCompare(b.name));
            devicesList.sensors.sort((a, b) => a.name.localeCompare(b.name));
            devicesList.scenarios.sort((a, b) => a.name.localeCompare(b.name));

            fs.writeFileSync(this.devicesFilePath, JSON.stringify(devicesList, null, 2));
            this.log.debug(`📝 Lista dispositivi salvata: ${this.discoveredDevices.size} dispositivi`);

            // Ritarda la stampa del riassunto per evitare duplicati durante la scoperta
            if (this.summaryTimeout) {
                clearTimeout(this.summaryTimeout);
            }
            const summaryDelay = this.config.devicesSummaryDelay || 2000;
            this.summaryTimeout = setTimeout(() => {
                this.printDevicesSummary(devicesList);
                this.summaryTimeout = undefined;
            }, summaryDelay); // Aspetta tempo configurabile dopo l'ultimo dispositivo scoperto
        } catch (error) {
            this.log.error('❌ Errore nel salvare la lista dispositivi:', error);
        }
    }

    private printDevicesSummary(devicesList: any): void {
        this.log.info('');
        this.log.info('📋 ========== DISPOSITIVI DISPONIBILI ==========');
        this.log.info('💡 Per escludere dispositivi, usa i seguenti ID:');
        this.log.info('');

        if (devicesList.outputs.length > 0) {
            this.log.info('🔌 OUTPUT (Luci, Tapparelle, Termostati):');
            devicesList.outputs.forEach((device: any) => {
                const icon = device.type === 'thermostat' ? '🌡️' : device.type === 'light' ? '💡' : '🪟';
                this.log.info(`   ID: ${device.id.padEnd(3)} - ${icon} ${device.name}`);
            });
            this.log.info('');
        }

        if (devicesList.zones.length > 0) {
            this.log.info('🚪 ZONE (Sensori di Sicurezza):');
            devicesList.zones.forEach((device: any) => {
                this.log.info(`   ID: ${device.id.padEnd(3)} - 🚪 ${device.name}`);
            });
            this.log.info('');
        }

        if (devicesList.sensors.length > 0) {
            this.log.info('🌡️ SENSORI (Temperatura, Umidità, Luminosità):');
            devicesList.sensors.forEach((device: any) => {
                const icon = device.name.includes('Temperatura') ? '🌡️' :
                    device.name.includes('Umidità') ? '💧' : '☀️';
                this.log.info(`   ID: ${device.id.padEnd(3)} - ${icon} ${device.name}`);
            });
            this.log.info('');
        }

        if (devicesList.scenarios.length > 0) {
            this.log.info('🎬 SCENARI (Automazioni):');
            devicesList.scenarios.forEach((device: any) => {
                this.log.info(`   ID: ${device.id.padEnd(3)} - 🎬 ${device.name}`);
            });
            this.log.info('');
        }

        this.log.info('📁 Lista completa salvata in: ' + this.devicesFilePath);
        this.log.info('🔧 Usa questi ID nella configurazione per escludere dispositivi');
        this.log.info('===============================================');
        this.log.info('');
    }

    private shouldExcludeDevice(device: KseniaDevice): boolean {
        const config = this.config as Lares4Config;
        const id = device.id.replace(/^(light_|cover_|sensor_temp_|sensor_hum_|sensor_light_|zone_|thermostat_|scenario_)/, '');

        if (device.type === 'zone' && config.excludeZones?.includes(id)) {
            this.log.info(`⏭️ Zona esclusa: ${device.name} (ID: ${id})`);
            return true;
        }
        if ((device.type === 'light' || device.type === 'cover' || device.type === 'thermostat') && config.excludeOutputs?.includes(id)) {
            this.log.info(`⏭️ Output escluso: ${device.name} (ID: ${id})`);
            return true;
        }
        if (device.type === 'sensor' && config.excludeSensors?.includes(id)) {
            this.log.info(`⏭️ Sensore escluso: ${device.name} (ID: ${id})`);
            return true;
        }
        if (device.type === 'scenario' && config.excludeScenarios?.includes(id)) {
            this.log.info(`⏭️ Scenario escluso: ${device.name} (ID: ${id})`);
            return true;
        }

        return false;
    }

    private getCustomName(device: KseniaDevice): string | undefined {
        const config = this.config as Lares4Config;
        const id = device.id.replace(/^(light_|cover_|sensor_temp_|sensor_hum_|sensor_light_|zone_|thermostat_|scenario_)/, '');

        if (device.type === 'zone') {
            return config.customNames?.zones?.[id];
        }
        if (device.type === 'light' || device.type === 'cover' || device.type === 'thermostat') {
            return config.customNames?.outputs?.[id];
        }
        if (device.type === 'sensor') {
            const sensorName = config.customNames?.sensors?.[id];
            if (sensorName) {
                // Mantieni il suffixo per i sensori multipli
                if (device.id.includes('_temp_')) return `${sensorName} - Temperatura`;
                if (device.id.includes('_hum_')) return `${sensorName} - Umidità`;
                if (device.id.includes('_light_')) return `${sensorName} - Luminosità`;
            }
        }
        if (device.type === 'scenario') {
            return config.customNames?.scenarios?.[id];
        }

        return undefined;
    }

    private handleDeviceStatusUpdate(device: KseniaDevice): void {
        this.log.debug(`🔄 Aggiornamento stato dispositivo: ${device.name}`);

        // Qui implementeremo l'aggiornamento dello stato degli accessori
        this.updateAccessory(device);
    }

    configureAccessory(accessory: PlatformAccessory): void {
        this.log.info('🔧 Caricamento accessorio dalla cache:', accessory.displayName);
        this.accessories.set(accessory.UUID, accessory);
    }

    // Metodi per la gestione degli accessori
    addAccessory(device: KseniaDevice): void {
        const uuid = this.api.hap.uuid.generate(device.id);
        const existingAccessory = this.accessories.get(uuid);

        if (existingAccessory) {
            this.log.info('🔄 Ripristino accessorio esistente dalla cache:', device.name);
            existingAccessory.context.device = device;
            this.createAccessoryHandler(existingAccessory, device);
        } else {
            this.log.info('🆕 Aggiunta nuovo accessorio:', device.name);
            const accessory = new this.api.platformAccessory(device.name, uuid);
            accessory.context.device = device;
            this.createAccessoryHandler(accessory, device);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.accessories.set(uuid, accessory);
        }
    }

    updateAccessory(device: KseniaDevice): void {
        const uuid = this.api.hap.uuid.generate(device.id);
        const accessory = this.accessories.get(uuid);
        const handler = this.accessoryHandlers.get(uuid);

        if (accessory && handler) {
            accessory.context.device = device;

            // Chiama il metodo updateStatus dell'handler specifico
            if (handler.updateStatus && typeof handler.updateStatus === 'function') {
                handler.updateStatus(device);
            }
        }
    }

    private createAccessoryHandler(accessory: PlatformAccessory, device: KseniaDevice): void {
        const uuid = accessory.UUID;

        // Rimuovi handler esistente se presente
        if (this.accessoryHandlers.has(uuid)) {
            this.accessoryHandlers.delete(uuid);
        }

        // Crea il nuovo handler in base al tipo di dispositivo
        let handler: any;

        switch (device.type) {
            case 'light':
                handler = new LightAccessory(this, accessory);
                this.log.debug(`💡 Creato handler per luce: ${device.name}`);
                break;
            case 'cover':
                handler = new CoverAccessory(this, accessory);
                this.log.debug(`🪟 Creato handler per tapparella: ${device.name}`);
                break;
            case 'sensor':
                handler = new SensorAccessory(this, accessory);
                this.log.debug(`🌡️ Creato handler per sensore: ${device.name}`);
                break;
            case 'zone':
                handler = new ZoneAccessory(this, accessory);
                this.log.debug(`🚪 Creato handler per zona: ${device.name}`);
                break;
            case 'thermostat':
                handler = new ThermostatAccessory(this, accessory);
                this.log.debug(`🌡️ Creato handler per termostato: ${device.name}`);
                break;
            case 'scenario':
                handler = new ScenarioAccessory(this, accessory, device);
                this.log.debug(`🎬 Creato handler per scenario: ${device.name}`);
                break;
            default:
                this.log.warn(`⚠️ Tipo dispositivo non supportato: ${device.type}`);
                return;
        }

        // Salva l'handler per aggiornamenti futuri
        this.accessoryHandlers.set(uuid, handler);
    }

    removeAccessory(accessory: PlatformAccessory): void {
        this.log.info('🗑️ Rimozione accessorio:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(accessory.UUID);
    }
} 