import * as mqtt from 'mqtt';
import type { Logger } from 'homebridge';
import type { KseniaDevice } from './types';
import type { Lares4Platform } from './platform';

export interface MqttConfig {
    enabled: boolean;
    broker: string;
    port?: number;
    username?: string;
    password?: string;
    clientId?: string;
    topicPrefix?: string;
    qos?: 0 | 1 | 2;
    retain?: boolean;
}

export class MqttBridge {
    private client?: mqtt.MqttClient;
    private readonly config: MqttConfig;
    private readonly log: Logger;
    private readonly platform: Lares4Platform;
    private readonly topicPrefix: string;

    constructor(config: MqttConfig, log: Logger, platform: Lares4Platform) {
        this.config = config;
        this.log = log;
        this.platform = platform;
        this.topicPrefix = config.topicPrefix || 'homebridge/klares4';

        if (config.enabled) {
            this.connect();
        }
    }

    private connect(): void {
        if (!this.config.broker) {
            this.log.warn('🚫 MQTT: Broker non configurato');
            return;
        }

        const options: mqtt.IClientOptions = {
            port: this.config.port || 1883,
            clientId: this.config.clientId || `homebridge-klares4-${Math.random().toString(16).substr(2, 8)}`,
            clean: true,
            reconnectPeriod: 5000,
            connectTimeout: 30000,
        };

        if (this.config.username && this.config.password) {
            options.username = this.config.username;
            options.password = this.config.password;
        }

        try {
            this.client = mqtt.connect(this.config.broker, options);
            this.setupEventHandlers();
        } catch (error) {
            this.log.error('❌ MQTT: Errore connessione:', error);
        }
    }

    private setupEventHandlers(): void {
        if (!this.client) return;

        this.client.on('connect', () => {
            this.log.info('✅ MQTT: Connesso al broker', this.config.broker);
            this.subscribeToCommands();
        });

        this.client.on('error', (error) => {
            this.log.error('❌ MQTT: Errore:', error);
        });

        this.client.on('reconnect', () => {
            this.log.info('🔄 MQTT: Riconnessione...');
        });

        this.client.on('offline', () => {
            this.log.warn('📴 MQTT: Disconnesso');
        });

        this.client.on('message', (topic, payload) => {
            this.handleIncomingMessage(topic, payload.toString());
        });
    }

    private subscribeToCommands(): void {
        if (!this.client) return;

        // Sottoscrivi ai comandi sia nel formato vecchio che nuovo
        const oldCommandTopic = `${this.topicPrefix}/+/+/set`;
        const newCommandTopic = `${this.topicPrefix}/+/+/+/set`;

        this.client.subscribe([oldCommandTopic, newCommandTopic], { qos: this.config.qos || 1 }, (error) => {
            if (error) {
                this.log.error('❌ MQTT: Errore sottoscrizione:', error);
            } else {
                this.log.info('📥 MQTT: Sottoscritto ai comandi:', [oldCommandTopic, newCommandTopic]);
            }
        });
    }

    private handleIncomingMessage(topic: string, payload: string): void {
        try {
            const topicParts = topic.split('/');
            let deviceType: string;
            let deviceIdentifier: string;

            // Supporta entrambi i formati:
            // Vecchio: homebridge/klares4/{deviceType}/{deviceId}/set
            // Nuovo: homebridge/klares4/{room}/{deviceType}/{deviceSlug}/set
            if (topicParts.length === 5 && topicParts[4] === 'set') {
                // Formato vecchio
                deviceType = topicParts[2];
                deviceIdentifier = topicParts[3];
            } else if (topicParts.length === 6 && topicParts[5] === 'set') {
                // Formato nuovo con stanza
                deviceType = topicParts[3];
                deviceIdentifier = topicParts[4];
            } else {
                this.log.warn('⚠️ MQTT: Formato topic non valido:', topic);
                return;
            }

            this.log.debug(`📥 MQTT: Comando ricevuto - Type: ${deviceType}, Identifier: ${deviceIdentifier}, Payload: ${payload}`);

            this.executeCommand(deviceType, deviceIdentifier, payload);
        } catch (error) {
            this.log.error('❌ MQTT: Errore elaborazione messaggio:', error);
        }
    }

    private executeCommand(deviceType: string, deviceIdentifier: string, payload: string): void {
        try {
            const command = JSON.parse(payload);

            // Trova l'accessorio corrispondente (supporta sia ID che slug del nome)
            const accessory = this.findAccessoryByDevice(deviceType, deviceIdentifier);
            if (!accessory) {
                this.log.warn(`⚠️ MQTT: Accessorio non trovato - Type: ${deviceType}, Identifier: ${deviceIdentifier}`);
                return;
            }

            // Esegui il comando in base al tipo di dispositivo
            switch (deviceType) {
                case 'light':
                    this.handleLightCommand(accessory, command);
                    break;
                case 'cover':
                    this.handleCoverCommand(accessory, command);
                    break;
                case 'thermostat':
                    this.handleThermostatCommand(accessory, command);
                    break;
                case 'scenario':
                    this.handleScenarioCommand(accessory, command);
                    break;
                default:
                    this.log.warn(`⚠️ MQTT: Tipo dispositivo non supportato per comandi: ${deviceType}`);
            }
        } catch (error) {
            this.log.error('❌ MQTT: Errore esecuzione comando:', error);
        }
    }

    private findAccessoryByDevice(deviceType: string, deviceIdentifier: string): any {
        // Cerca nell'handler degli accessori
        for (const [uuid, handler] of this.platform.accessoryHandlers) {
            const device = handler.device || handler.accessory?.context?.device;
            if (device && device.type === deviceType) {
                // Supporta sia ID che slug del nome
                const deviceSlug = this.createDeviceSlug(device.name);
                if (device.id === deviceIdentifier || deviceSlug === deviceIdentifier) {
                    return handler;
                }
            }
        }
        return null;
    }

    private handleLightCommand(accessory: any, command: any): void {
        if (command.on !== undefined) {
            accessory.setOn(command.on);
            this.log.info(`💡 MQTT: Luce ${accessory.device.name} → ${command.on ? 'ON' : 'OFF'}`);
        }
        if (command.brightness !== undefined && accessory.setBrightness) {
            accessory.setBrightness(command.brightness);
            this.log.info(`💡 MQTT: Luminosità ${accessory.device.name} → ${command.brightness}%`);
        }
    }

    private handleCoverCommand(accessory: any, command: any): void {
        if (command.position !== undefined) {
            accessory.setTargetPosition(command.position);
            this.log.info(`🪟 MQTT: Tapparella ${accessory.device.name} → ${command.position}%`);
        }
    }

    private handleThermostatCommand(accessory: any, command: any): void {
        if (command.targetTemperature !== undefined) {
            accessory.setTargetTemperature(command.targetTemperature);
            this.log.info(`🌡️ MQTT: Termostato ${accessory.device.name} → ${command.targetTemperature}°C`);
        }
        if (command.mode !== undefined) {
            accessory.setTargetHeatingCoolingState(this.getModeValue(command.mode));
            this.log.info(`🌡️ MQTT: Modalità termostato ${accessory.device.name} → ${command.mode}`);
        }
    }

    private handleScenarioCommand(accessory: any, command: any): void {
        if (command.active !== undefined && command.active) {
            accessory.setOn(true);
            this.log.info(`🎬 MQTT: Scenario ${accessory.device.name} → Attivato`);
        }
    }

    private getModeValue(mode: string): number {
        switch (mode) {
            case 'off': return 0;
            case 'heat': return 1;
            case 'cool': return 2;
            case 'auto': return 3;
            default: return 0;
        }
    }

    private createDeviceSlug(deviceName: string): string {
        return deviceName
            .toLowerCase()
            .replace(/\s+/g, '_')           // spazi → underscore
            .replace(/[àáâãäå]/g, 'a')      // caratteri accentati
            .replace(/[èéêë]/g, 'e')
            .replace(/[ìíîï]/g, 'i')
            .replace(/[òóôõö]/g, 'o')
            .replace(/[ùúûü]/g, 'u')
            .replace(/[ç]/g, 'c')
            .replace(/[^a-z0-9_]/g, '')     // rimuovi caratteri speciali
            .replace(/_+/g, '_')            // rimuovi underscore multipli
            .replace(/^_|_$/g, '');         // rimuovi underscore iniziali/finali
    }

    private getRoomForDevice(deviceId: string): string {
        // Se la mappatura stanze non è abilitata, usa il comportamento predefinito
        if (!this.platform.config.roomMapping?.enabled) {
            return 'klares4';
        }

        // Cerca il dispositivo nelle stanze configurate
        if (this.platform.config.roomMapping.rooms) {
            for (const room of this.platform.config.roomMapping.rooms) {
                if (room.devices) {
                    for (const device of room.devices) {
                        if (device.deviceId === deviceId) {
                            return room.roomName;
                        }
                    }
                }
            }
        }

        // Se non trovato in nessuna stanza, usa il comportamento predefinito
        return 'klares4';
    }

    // Metodo pubblico per pubblicare stati dispositivi
    publishDeviceState(device: KseniaDevice): void {
        if (!this.client || !this.config.enabled) return;

        const room = this.getRoomForDevice(device.id);
        const deviceSlug = this.createDeviceSlug(device.name);
        const topic = `${this.topicPrefix}/${room}/${device.type}/${deviceSlug}/state`;
        const payload = this.createStatePayload(device);

        this.client.publish(topic, JSON.stringify(payload), {
            qos: this.config.qos || 1,
            retain: this.config.retain || true
        }, (error) => {
            if (error) {
                this.log.error('❌ MQTT: Errore pubblicazione:', error);
            } else {
                this.log.debug(`📤 MQTT: Pubblicato stato ${room}/${device.type}/${deviceSlug}`);
            }
        });
    }

    private createStatePayload(device: KseniaDevice): any {
        const basePayload = {
            id: device.id,
            name: device.name,
            type: device.type,
            timestamp: new Date().toISOString()
        };

        // Aggiungi dati specifici per tipo di dispositivo
        switch (device.type) {
            case 'light':
                const light = device as any;
                return {
                    ...basePayload,
                    on: light.on || false,
                    brightness: light.brightness || 0,
                    dimmable: light.dimmable || false
                };

            case 'cover':
                const cover = device as any;
                return {
                    ...basePayload,
                    position: cover.status?.position || 0,
                    state: cover.status?.state || 'stopped'
                };

            case 'thermostat':
                const thermostat = device as any;
                return {
                    ...basePayload,
                    currentTemperature: thermostat.currentTemperature || 0,
                    targetTemperature: thermostat.targetTemperature || 20,
                    mode: thermostat.mode || 'off',
                    humidity: thermostat.humidity
                };

            case 'sensor':
                const sensor = device as any;
                return {
                    ...basePayload,
                    sensorType: sensor.status?.sensorType || 'unknown',
                    value: sensor.status?.value || 0,
                    unit: sensor.status?.unit || ''
                };

            case 'zone':
                const zone = device as any;
                return {
                    ...basePayload,
                    open: zone.status?.open || false,
                    armed: zone.status?.armed || false,
                    fault: zone.status?.fault || false,
                    bypassed: zone.status?.bypassed || false
                };

            case 'scenario':
                const scenario = device as any;
                return {
                    ...basePayload,
                    active: scenario.active || false
                };

            default:
                return basePayload;
        }
    }

    // Metodo per disconnettere MQTT
    disconnect(): void {
        if (this.client) {
            this.client.end();
            this.log.info('📴 MQTT: Disconnesso');
        }
    }
}
