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

        const commandTopic = `${this.topicPrefix}/+/+/set`;
        this.client.subscribe(commandTopic, { qos: this.config.qos || 1 }, (error) => {
            if (error) {
                this.log.error('❌ MQTT: Errore sottoscrizione:', error);
            } else {
                this.log.info('📥 MQTT: Sottoscritto ai comandi:', commandTopic);
            }
        });
    }

    private handleIncomingMessage(topic: string, payload: string): void {
        try {
            const topicParts = topic.split('/');
            
            // Format: homebridge/klares4/{deviceType}/{deviceId}/set
            if (topicParts.length !== 5 || topicParts[4] !== 'set') {
                this.log.warn('⚠️ MQTT: Formato topic non valido:', topic);
                return;
            }

            const deviceType = topicParts[2];
            const deviceId = topicParts[3];
            
            this.log.debug(`📥 MQTT: Comando ricevuto - Type: ${deviceType}, ID: ${deviceId}, Payload: ${payload}`);
            
            this.executeCommand(deviceType, deviceId, payload);
        } catch (error) {
            this.log.error('❌ MQTT: Errore elaborazione messaggio:', error);
        }
    }

    private executeCommand(deviceType: string, deviceId: string, payload: string): void {
        try {
            const command = JSON.parse(payload);
            
            // Trova l'accessorio corrispondente
            const accessory = this.findAccessoryByDevice(deviceType, deviceId);
            if (!accessory) {
                this.log.warn(`⚠️ MQTT: Accessorio non trovato - Type: ${deviceType}, ID: ${deviceId}`);
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

    private findAccessoryByDevice(deviceType: string, deviceId: string): any {
        // Cerca nell'handler degli accessori
        for (const [uuid, handler] of this.platform.accessoryHandlers) {
            const device = handler.device || handler.accessory?.context?.device;
            if (device && device.type === deviceType && device.id === deviceId) {
                return handler;
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

    // Metodo pubblico per pubblicare stati dispositivi
    publishDeviceState(device: KseniaDevice): void {
        if (!this.client || !this.config.enabled) return;

        const topic = `${this.topicPrefix}/${device.type}/${device.id}/state`;
        const payload = this.createStatePayload(device);

        this.client.publish(topic, JSON.stringify(payload), {
            qos: this.config.qos || 1,
            retain: this.config.retain || true
        }, (error) => {
            if (error) {
                this.log.error('❌ MQTT: Errore pubblicazione:', error);
            } else {
                this.log.debug(`📤 MQTT: Pubblicato stato ${device.type}/${device.id}`);
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
