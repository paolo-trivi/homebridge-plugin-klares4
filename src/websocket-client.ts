import WebSocket from 'ws';
import * as https from 'https';
import * as crypto from 'crypto';
import { Logger } from 'homebridge';

import {
    KseniaMessage,
    KseniaWebSocketOptions,
    KseniaDevice,
    KseniaOutputData,
    KseniaZoneData,
    KseniaSensorData
} from './types';

export class KseniaWebSocketClient {
    private ws?: WebSocket;
    private isConnected = false;
    private idLogin?: string;
    private heartbeatTimer?: NodeJS.Timeout;
    private reconnectTimer?: NodeJS.Timeout;

    // Event handlers
    public onDeviceDiscovered?: (device: KseniaDevice) => void;
    public onDeviceStatusUpdate?: (device: KseniaDevice) => void;
    public onConnected?: () => void;
    public onDisconnected?: () => void;

    // Device storage
    private devices: Map<string, KseniaDevice> = new Map();

    constructor(
        private readonly ip: string,
        private readonly port: number,
        private readonly useHttps: boolean,
        private readonly sender: string,
        private readonly pin: string,
        private readonly log: Logger,
        private readonly options: KseniaWebSocketOptions = {}
    ) {
        this.options = {
            debug: false,
            reconnectInterval: 5000,
            heartbeatInterval: 30000,
            ...options
        };
    }

    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const protocol = this.useHttps ? 'wss' : 'ws';
                const wsUrl = `${protocol}://${this.ip}:${this.port}/KseniaWsock/`;

                this.log.info(`🔗 Connessione a ${wsUrl}...`);

                const wsOptions: any = {};
                if (this.useHttps) {
                    wsOptions.rejectUnauthorized = false;
                    wsOptions.agent = new https.Agent({
                        rejectUnauthorized: false,
                        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
                        secureProtocol: 'TLS_method',
                        ciphers: 'ALL:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA'
                    });
                }

                this.ws = new WebSocket(wsUrl, ['KS_WSOCK'], wsOptions);

                this.ws.on('open', () => {
                    this.log.info('✅ WebSocket connesso');
                    this.isConnected = true;
                    this.login().then(() => {
                        this.onConnected?.();
                        resolve();
                    }).catch(reject);
                });

                this.ws.on('message', (data: WebSocket.Data) => {
                    this.handleMessage(data.toString());
                });

                this.ws.on('close', (code: number, reason: Buffer) => {
                    this.log.warn(`🔌 WebSocket chiuso: ${code} - ${reason.toString()}`);
                    this.isConnected = false;
                    this.onDisconnected?.();
                    this.scheduleReconnect();
                });

                this.ws.on('error', (error: Error) => {
                    this.log.error('❌ Errore WebSocket:', error.message);
                    reject(error);
                });

            } catch (error) {
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
                PIN: this.pin
            },
            TIMESTAMP: Math.floor(Date.now() / 1000).toString(),
            CRC_16: '0x0000'
        };

        loginMessage.CRC_16 = this.calculateCRC16(JSON.stringify(loginMessage));

        this.log.info('🔐 Esecuzione login...');
        await this.sendMessage(loginMessage);
    }

    private handleMessage(data: string): void {
        try {
            const message: KseniaMessage = JSON.parse(data);

            // Filtra i messaggi di debug
            const isHeartbeat = message.CMD === 'PING' || message.PAYLOAD_TYPE === 'HEARTBEAT';
            const isGenericRealtime = message.CMD === 'REALTIME' && message.PAYLOAD_TYPE === 'CHANGES';

            // Mostra messaggi solo se sono importanti o se siamo in debug
            if (this.options.debug || (!isHeartbeat && !isGenericRealtime)) {
                this.log.info(`📨 Ricevuto: ${data}`);
            } else if (isHeartbeat || isGenericRealtime) {
                this.log.debug(`📨 Debug: ${data}`);
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
                    // I messaggi real-time di aggiornamento stato
                    if (message.PAYLOAD_TYPE === 'CHANGES') {
                        this.handleStatusUpdate(message);
                    }
                    break;
                case 'STATUS_UPDATE':
                    this.handleStatusUpdate(message);
                    break;
                case 'PING':
                    // PING ricevuto - rispondi solo in debug
                    if (this.options.debug) {
                        this.log.debug(`🏓 PING ricevuto dal sistema`);
                    }
                    break;
                default:
                    if (this.options.debug) {
                        this.log.debug(`📋 Messaggio non gestito: ${message.CMD}`);
                    }
            }
        } catch (error) {
            this.log.error('❌ Errore parsing messaggio:', error);
        }
    }

    private handleLoginResponse(message: KseniaMessage): void {
        if (message.PAYLOAD?.RESULT === 'OK') {
            this.idLogin = message.PAYLOAD.ID_LOGIN || '1';
            this.log.info(`✅ Login completato, ID_LOGIN: ${this.idLogin}`);
            this.startHeartbeat();
            this.requestSystemData();
        } else {
            this.log.error('❌ Login fallito:', message.PAYLOAD?.RESULT_DETAIL);
        }
    }

    private async requestSystemData(): Promise<void> {
        if (!this.idLogin) {
            this.log.error('❌ ID_LOGIN non disponibile');
            return;
        }

        this.log.info('📥 Richiesta dati sistema...');

        // Richiedi zone
        await this.sendKseniaCommand('READ', 'ZONES', {
            ID_LOGIN: this.idLogin,
            ID_ITEMS_RANGE: ['ALL', 'ALL']
        });

        // Richiedi output (luci, tapparelle, ecc.)
        await this.sendKseniaCommand('READ', 'MULTI_TYPES', {
            ID_LOGIN: this.idLogin,
            TYPES: ['OUTPUTS', 'BUS_HAS', 'SCENARIOS']
        });

        // Richiedi stati attuali degli output (FONDAMENTALE per sincronizzare stati iniziali!)
        await this.sendKseniaCommand('READ', 'STATUS_OUTPUTS', {
            ID_LOGIN: this.idLogin
        });

        // Richiedi stati attuali dei sensori
        await this.sendKseniaCommand('READ', 'STATUS_BUS_HA_SENSORS', {
            ID_LOGIN: this.idLogin
        });

        // Richiedi stati del sistema (AGGIUNTO per termostati!)
        await this.sendKseniaCommand('READ', 'STATUS_SYSTEM', {
            ID_LOGIN: this.idLogin
        });

        // Registra per aggiornamenti real-time
        await this.sendKseniaCommand('REALTIME', 'REGISTER', {
            ID_LOGIN: this.idLogin,
            TYPES: [
                'STATUS_ZONES',
                'STATUS_OUTPUTS',
                'STATUS_BUS_HA_SENSORS',
                'STATUS_SYSTEM',
                'SCENARIOS'
            ]
        });
    }

    private handleReadResponse(message: KseniaMessage): void {
        const payload = message.PAYLOAD;

        this.log.info(`📥 Risposta ricevuta: ${message.PAYLOAD_TYPE}`);

        if (message.PAYLOAD_TYPE === 'ZONES' && payload.ZONES) {
            this.log.info(`🏠 Trovate ${payload.ZONES.length} zone`);
            payload.ZONES.forEach((zone: KseniaZoneData) => {
                const device = this.parseZoneData(zone);
                this.devices.set(device.id, device);
                this.onDeviceDiscovered?.(device);
            });
        }

        if (message.PAYLOAD_TYPE === 'MULTI_TYPES') {
            if (payload.OUTPUTS) {
                this.log.info(`💡 Trovati ${payload.OUTPUTS.length} output`);
                payload.OUTPUTS.forEach((output: KseniaOutputData) => {
                    // Log dettagliato per debugging termostati
                    const category = (output as any).CAT || output.TYPE || '';
                    const type = this.determineOutputType(category);

                    if (type === 'thermostat') {
                        this.log.info(`🌡️ DEBUG Termostato trovato - ID: ${output.ID}, DES: ${output.DES}, TYPE: ${output.TYPE}, CAT: ${(output as any).CAT}, RAW: ${JSON.stringify(output)}`);
                    }

                    const device = this.parseOutputData(output);
                    if (device) {
                        this.devices.set(device.id, device);
                        this.onDeviceDiscovered?.(device);
                    }
                });
            }

            if (payload.SCENARIOS) {
                this.log.info(`🎬 Trovati ${payload.SCENARIOS.length} scenari`);
                payload.SCENARIOS.forEach((scenario: any) => {
                    // Filtra gli scenari ARM/DISARM come fa lares4-ts
                    if (scenario.CAT === 'ARM' || scenario.CAT === 'DISARM') {
                        this.log.debug(`⏭️ Scenario ${scenario.DES} ignorato (categoria ${scenario.CAT})`);
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
                this.log.info(`🌡️ Trovati ${payload.BUS_HAS.length} sensori`);
                payload.BUS_HAS.forEach((sensor: KseniaSensorData) => {
                    // Crea sensori multipli per ogni DOMUS
                    const baseName = sensor.DES || `Sensore ${sensor.ID}`;

                    // Sensore temperatura
                    const tempDevice = {
                        id: `sensor_temp_${sensor.ID}`,
                        type: 'sensor' as const,
                        name: `${baseName} - Temperatura`,
                        description: `${baseName} - Temperatura`,
                        status: {
                            sensorType: 'temperature',
                            value: undefined, // Sarà aggiornato dai dati real-time
                            unit: '°C'
                        }
                    };
                    this.devices.set(tempDevice.id, tempDevice);
                    this.onDeviceDiscovered?.(tempDevice);

                    // Sensore umidità
                    const humDevice = {
                        id: `sensor_hum_${sensor.ID}`,
                        type: 'sensor' as const,
                        name: `${baseName} - Umidità`,
                        description: `${baseName} - Umidità`,
                        status: {
                            sensorType: 'humidity',
                            value: 50,
                            unit: '%'
                        }
                    };
                    this.devices.set(humDevice.id, humDevice);
                    this.onDeviceDiscovered?.(humDevice);

                    // Sensore luminosità
                    const lightDevice = {
                        id: `sensor_light_${sensor.ID}`,
                        type: 'sensor' as const,
                        name: `${baseName} - Luminosità`,
                        description: `${baseName} - Luminosità`,
                        status: {
                            sensorType: 'light',
                            value: 100,
                            unit: 'lux'
                        }
                    };
                    this.devices.set(lightDevice.id, lightDevice);
                    this.onDeviceDiscovered?.(lightDevice);
                });
            }
        }

        // Gestisci stati iniziali degli output
        if (message.PAYLOAD_TYPE === 'STATUS_OUTPUTS' && payload.STATUS_OUTPUTS) {
            this.log.info(`📊 Stati iniziali ${payload.STATUS_OUTPUTS.length} output`);
            // Log dettagliato per debugging termostati
            payload.STATUS_OUTPUTS.forEach((output: any) => {
                const thermostatDevice = this.devices.get(`thermostat_${output.ID}`);
                if (thermostatDevice) {
                    this.log.info(`🌡️ DEBUG Stato iniziale termostato ${output.ID}: ${JSON.stringify(output)}`);
                }
            });
            this.updateOutputStatuses(payload.STATUS_OUTPUTS);
        }

        // Gestisci stati iniziali dei sensori
        if (message.PAYLOAD_TYPE === 'STATUS_BUS_HA_SENSORS' && payload.STATUS_BUS_HA_SENSORS) {
            this.log.info(`🌡️ Stati iniziali ${payload.STATUS_BUS_HA_SENSORS.length} sensori`);
            this.updateSensorStatuses(payload.STATUS_BUS_HA_SENSORS);
        }

        // Gestisci stati iniziali del sistema
        if (message.PAYLOAD_TYPE === 'STATUS_SYSTEM' && payload.STATUS_SYSTEM) {
            this.log.info(`🌡️ Temperature sistema iniziali`);
            this.updateSystemTemperatures(payload.STATUS_SYSTEM);
        }
    }

    private handleRealtimeResponse(message: KseniaMessage): void {
        this.log.info('🔄 Registrazione real-time completata');

        // Processa gli stati iniziali se presenti
        const payload = message.PAYLOAD;
        if (payload.STATUS_OUTPUTS) {
            this.log.info(`📊 Aggiornamento stati ${payload.STATUS_OUTPUTS.length} output`);
            this.updateOutputStatuses(payload.STATUS_OUTPUTS);
        }
        if (payload.STATUS_BUS_HA_SENSORS) {
            this.log.info(`🌡️ Aggiornamento stati ${payload.STATUS_BUS_HA_SENSORS.length} sensori`);
            this.updateSensorStatuses(payload.STATUS_BUS_HA_SENSORS);
        }
        if (payload.STATUS_ZONES) {
            this.log.info(`🚪 Aggiornamento stati ${payload.STATUS_ZONES.length} zone`);
            this.updateZoneStatuses(payload.STATUS_ZONES);
        }
        if (payload.STATUS_SYSTEM) {
            this.log.info(`🌡️ Aggiornamento temperature sistema iniziali`);
            this.updateSystemTemperatures(payload.STATUS_SYSTEM);
        }
    }

    private handleStatusUpdate(message: KseniaMessage): void {
        // Gestisce gli aggiornamenti di stato in tempo reale
        const payload = message.PAYLOAD;
        this.log.debug(`🔄 handleStatusUpdate chiamato, payload keys: ${Object.keys(payload)}`);

        // I messaggi real-time hanno un formato diverso
        for (const [sender, data] of Object.entries(payload)) {
            if (data && typeof data === 'object') {
                const statusData = data as any;

                if (statusData.STATUS_OUTPUTS) {
                    this.log.info(`📊 Aggiornamento real-time ${statusData.STATUS_OUTPUTS.length} output`);
                    this.updateOutputStatuses(statusData.STATUS_OUTPUTS);
                }
                if (statusData.STATUS_BUS_HA_SENSORS) {
                    this.log.info(`🌡️ Aggiornamento real-time ${statusData.STATUS_BUS_HA_SENSORS.length} sensori`);
                    this.updateSensorStatuses(statusData.STATUS_BUS_HA_SENSORS);
                }
                if (statusData.STATUS_ZONES) {
                    this.log.info(`🚪 Aggiornamento real-time ${statusData.STATUS_ZONES.length} zone`);
                    this.updateZoneStatuses(statusData.STATUS_ZONES);
                }
                if (statusData.STATUS_SYSTEM) {
                    this.log.info(`🌡️ Aggiornamento temperature sistema`);
                    this.updateSystemTemperatures(statusData.STATUS_SYSTEM);
                }
            }
        }
    }

    private parseZoneData(zoneData: KseniaZoneData): KseniaDevice {
        return {
            id: `zone_${zoneData.ID}`,
            type: 'zone',
            name: zoneData.DES || `Zona ${zoneData.ID}`,
            description: zoneData.DES || '',
            status: {
                armed: zoneData.STATUS === '1',
                bypassed: false,
                fault: false,
                open: zoneData.STATUS === '2'
            }
        };
    }

    private parseOutputData(outputData: KseniaOutputData): KseniaDevice | null {
        // Usa CAT (categoria) dal payload reale - implementazione diretta senza libreria
        const category = (outputData as any).CAT || outputData.TYPE || '';
        const categoryUpper = category.toUpperCase();

        // Usa l'ID reale del sistema (non remappato)
        const systemId = outputData.ID;

        if (categoryUpper === 'LIGHT') {
            return {
                id: `light_${systemId}`,
                type: 'light',
                name: outputData.DES || `Luce ${systemId}`,
                description: outputData.DES || '',
                status: {
                    on: false, // Sarà aggiornato dai dati real-time
                    brightness: undefined,
                    dimmable: false
                }
            };
        } else if (categoryUpper === 'ROLL') {
            return {
                id: `cover_${systemId}`,
                type: 'cover',
                name: outputData.DES || `Tapparella ${systemId}`,
                description: outputData.DES || '',
                status: {
                    position: 0, // Sarà aggiornato dai dati real-time
                    state: 'stopped'
                }
            };
        } else if (categoryUpper === 'GATE') {
            return {
                id: `cover_${systemId}`, // I cancelli sono trattati come cover
                type: 'cover',
                name: outputData.DES || `Cancello ${systemId}`,
                description: outputData.DES || '',
                status: {
                    position: 0,
                    state: 'stopped'
                }
            };
        }

        // Ignora altri tipi di output per ora
        this.log.debug(`📋 Output ignorato: ID ${systemId}, CAT: ${category}, DES: ${outputData.DES}`);
        return null;
    }

    private parseSensorData(sensorData: KseniaSensorData): KseniaDevice | null {
        const baseName = sensorData.DES || `Sensore ${sensorData.ID}`;

        // Creiamo solo il sensore temperatura per ora
        return {
            id: `sensor_temp_${sensorData.ID}`,
            type: 'sensor',
            name: `${baseName} - Temperatura`,
            description: `${baseName} - Temperatura`,
            status: {
                sensorType: 'temperature',
                value: undefined, // Sarà aggiornato dai dati real-time
                unit: '°C'
            }
        };
    }

    private parseScenarioData(scenarioData: any): KseniaDevice | null {
        return {
            id: `scenario_${scenarioData.ID}`,
            type: 'scenario',
            name: scenarioData.DES || `Scenario ${scenarioData.ID}`,
            description: scenarioData.DES || '',
            status: {
                active: false // Gli scenari non hanno uno stato persistente
            }
        };
    }

    private determineOutputType(category: string): 'light' | 'cover' | 'thermostat' | 'scenario' {
        const catUpper = category.toUpperCase();

        // Log per debugging
        this.log.debug(`🔍 Determinazione tipo per categoria: "${category}" (normalizzato: "${catUpper}")`);

        // Usa la logica della libreria lares4-ts basata sul campo CAT
        if (catUpper === 'ROLL') {
            this.log.debug(`✅ Identificato come tapparella: ${category}`);
            return 'cover';
        }

        if (catUpper === 'LIGHT') {
            this.log.debug(`✅ Identificato come luce: ${category}`);
            return 'light';
        }

        if (catUpper === 'GATE') {
            this.log.debug(`✅ Identificato come cancello (trattato come copertura): ${category}`);
            return 'cover';
        }

        // Termostati - controlla diverse possibili denominazioni per retrocompatibilità
        if (catUpper.includes('THERM') ||
            catUpper.includes('CLIMA') ||
            catUpper.includes('TEMP') ||
            catUpper.includes('RISCALD') ||
            catUpper.includes('RAFFRES') ||
            catUpper.includes('HVAC') ||
            catUpper.includes('TERMOS')) {
            this.log.debug(`✅ Identificato come termostato: ${category}`);
            return 'thermostat';
        }

        // Default: luce (per compatibilità con sistemi più vecchi)
        this.log.debug(`✅ Identificato come luce (default): ${category}`);
        return 'light';
    }

    private determineSensorType(type: string): 'temperature' | 'humidity' | 'light' | 'motion' | 'contact' {
        if (type.includes('TEMP')) return 'temperature';
        if (type.includes('HUM')) return 'humidity';
        if (type.includes('LIGHT') || type.includes('LUX')) return 'light';
        if (type.includes('MOTION') || type.includes('PIR')) return 'motion';
        if (type.includes('CONTACT') || type.includes('DOOR')) return 'contact';
        return 'temperature'; // Default
    }

    private updateOutputStatuses(outputs: any[]): void {
        outputs.forEach(output => {
            this.log.debug(`📊 Aggiornamento output ${output.ID}: STA=${output.STA}, POS=${output.POS}, TPOS=${output.TPOS}`);

            // Usa gli ID reali del sistema (non remappati)
            const lightDevice = this.devices.get(`light_${output.ID}`);
            if (lightDevice) {
                const wasOn = (lightDevice.status as any).on;
                (lightDevice.status as any).on = output.STA === 'ON';
                if (output.POS !== undefined) {
                    (lightDevice.status as any).brightness = parseInt(output.POS);
                    (lightDevice.status as any).dimmable = true;
                }
                if (wasOn !== (output.STA === 'ON')) {
                    this.log.info(`💡 Luce ${lightDevice.name} (Output ${output.ID}): ${output.STA === 'ON' ? 'ACCESA' : 'SPENTA'}`);
                }
                this.onDeviceStatusUpdate?.(lightDevice);
            }

            const coverDevice = this.devices.get(`cover_${output.ID}`);
            if (coverDevice) {
                const oldPos = (coverDevice.status as any).position;
                const newPosition = this.mapCoverPosition(output.STA, output.POS);
                (coverDevice.status as any).position = newPosition;
                (coverDevice.status as any).targetPosition = parseInt(output.TPOS || output.POS || '0');
                (coverDevice.status as any).state = this.mapCoverState(output.STA, output.POS, output.TPOS);

                if (oldPos !== newPosition) {
                    this.log.info(`🪟 Cover ${coverDevice.name} (Output ${output.ID}): ${output.STA} posizione ${newPosition}%`);
                }
                this.onDeviceStatusUpdate?.(coverDevice);
            }

            const thermostatDevice = this.devices.get(`thermostat_${output.ID}`);
            if (thermostatDevice) {
                // IMPLEMENTAZIONE REALE PER TERMOSTATI
                // Aggiorna i dati del termostato se disponibili
                let updated = false;

                // Se abbiamo dati di temperatura nel payload (dipende dal protocollo Lares4)
                if (output.TEMP_CURRENT !== undefined) {
                    const oldCurrentTemp = (thermostatDevice.status as any).currentTemperature;
                    const newCurrentTemp = parseFloat(output.TEMP_CURRENT);
                    (thermostatDevice.status as any).currentTemperature = newCurrentTemp;
                    if (oldCurrentTemp !== newCurrentTemp) {
                        this.log.info(`🌡️ ${thermostatDevice.name}: Temperatura corrente ${newCurrentTemp}°C`);
                        updated = true;
                    }
                }

                if (output.TEMP_TARGET !== undefined) {
                    const oldTargetTemp = (thermostatDevice.status as any).targetTemperature;
                    const newTargetTemp = parseFloat(output.TEMP_TARGET);
                    (thermostatDevice.status as any).targetTemperature = newTargetTemp;
                    if (oldTargetTemp !== newTargetTemp) {
                        this.log.info(`🌡️ ${thermostatDevice.name}: Temperatura target ${newTargetTemp}°C`);
                        updated = true;
                    }
                }

                if (output.MODE !== undefined) {
                    const oldMode = (thermostatDevice.status as any).mode;
                    const newMode = this.mapThermostatMode(output.MODE);
                    (thermostatDevice.status as any).mode = newMode;
                    if (oldMode !== newMode) {
                        this.log.info(`🌡️ ${thermostatDevice.name}: Modalità ${newMode}`);
                        updated = true;
                    }
                }

                // Se abbiamo aggiornato qualcosa, notifica l'accessorio
                if (updated) {
                    this.onDeviceStatusUpdate?.(thermostatDevice);
                } else {
                    // Log di debug per capire che dati stanno arrivando per i termostati
                    this.log.debug(`🌡️ Debug termostato ${output.ID}: ${JSON.stringify(output)}`);
                }
            }
        });
    }

    private updateSensorStatuses(sensors: any[]): void {
        sensors.forEach(sensor => {
            if (sensor.DOMUS) {
                this.log.debug(`🌡️ Aggiornamento sensore ${sensor.ID}: TEM=${sensor.DOMUS.TEM}°C, HUM=${sensor.DOMUS.HUM}%, LHT=${sensor.DOMUS.LHT}lux`);

                const tempDevice = this.devices.get(`sensor_temp_${sensor.ID}`);
                if (tempDevice) {
                    const oldTemp = (tempDevice.status as any).value;
                    const newTemp = parseFloat(sensor.DOMUS.TEM || '0'); // Usa 0 invece di 20 come fallback
                    (tempDevice.status as any).value = newTemp;
                    if (oldTemp !== newTemp && newTemp > 0) { // Log solo se abbiamo una temperatura valida
                        this.log.info(`🌡️ ${tempDevice.name}: ${newTemp}°C`);
                    }
                    this.onDeviceStatusUpdate?.(tempDevice);
                }

                const humDevice = this.devices.get(`sensor_hum_${sensor.ID}`);
                if (humDevice) {
                    const oldHum = (humDevice.status as any).value;
                    const newHum = parseInt(sensor.DOMUS.HUM || '50');
                    (humDevice.status as any).value = newHum;
                    if (oldHum !== newHum) {
                        this.log.info(`💧 ${humDevice.name}: ${newHum}%`);
                    }
                    this.onDeviceStatusUpdate?.(humDevice);
                }

                const lightDevice = this.devices.get(`sensor_light_${sensor.ID}`);
                if (lightDevice) {
                    const oldLight = (lightDevice.status as any).value;
                    const newLight = parseInt(sensor.DOMUS.LHT || '100');
                    (lightDevice.status as any).value = newLight;
                    if (oldLight !== newLight) {
                        this.log.info(`☀️ ${lightDevice.name}: ${newLight}lux`);
                    }
                    this.onDeviceStatusUpdate?.(lightDevice);
                }
            }
        });
    }

    private updateZoneStatuses(zones: any[]): void {
        zones.forEach(zone => {
            this.log.debug(`🚪 Aggiornamento zona ${zone.ID}: STA=${zone.STA}, BYP=${zone.BYP}, A=${zone.A}`);

            const zoneDevice = this.devices.get(`zone_${zone.ID}`);
            if (zoneDevice) {
                const oldOpen = (zoneDevice.status as any).open;
                const newOpen = zone.STA === 'A'; // A = Aperta/Allarme, R = Riposo

                (zoneDevice.status as any).open = newOpen;
                (zoneDevice.status as any).bypassed = zone.BYP === 'YES';
                (zoneDevice.status as any).armed = zone.A === 'Y';
                (zoneDevice.status as any).fault = zone.FM === 'T';

                if (oldOpen !== newOpen) {
                    this.log.info(`🚪 ${zoneDevice.name}: ${newOpen ? 'APERTA/ALLARME' : 'RIPOSO'}`);
                }

                this.onDeviceStatusUpdate?.(zoneDevice);
            }
        });
    }

    private mapCoverPosition(sta: string, pos?: string): number {
        // Per cancelli e tapparelle, converti lo stato in posizione percentuale
        if (pos !== undefined && pos !== '') {
            return parseInt(pos);
        }

        // Fallback basato sullo stato
        switch (sta?.toUpperCase()) {
            case 'OPEN':
            case 'UP':
                return 100;
            case 'CLOSE':
            case 'DOWN':
                return 0;
            case 'STOP':
                return 50; // Posizione intermedia se ferma
            default:
                return 0;
        }
    }

    private mapCoverState(sta: string, pos?: string, tpos?: string): 'stopped' | 'opening' | 'closing' {
        // Se abbiamo posizione e target position, verifichiamo se è in movimento
        if (pos !== undefined && tpos !== undefined) {
            const currentPos = parseInt(pos);
            const targetPos = parseInt(tpos);

            if (currentPos === targetPos) {
                return 'stopped'; // Ferma nella posizione target
            } else if (currentPos < targetPos) {
                return 'opening'; // Si sta aprendo (verso 100)
            } else {
                return 'closing'; // Si sta chiudendo (verso 0)
            }
        }

        // Fallback alla logica precedente se non abbiamo posizioni
        switch (sta?.toUpperCase()) {
            case 'UP':
            case 'OPEN': return 'opening';
            case 'DOWN':
            case 'CLOSE': return 'closing';
            case 'STOP':
            default: return 'stopped';
        }
    }

    // Metodi per controllare i dispositivi
    public async switchLight(lightId: string, on: boolean): Promise<void> {
        if (!this.idLogin) throw new Error('Non connesso');

        const systemOutputId = lightId.replace('light_', '');

        // Usa formato corretto con sostituzione automatica di ID_LOGIN e PIN
        await this.sendKseniaCommand('CMD_USR', 'CMD_SET_OUTPUT', {
            ID_LOGIN: 'true', // Sarà sostituito con this.idLogin
            PIN: 'true',       // Sarà sostituito con this.pin
            OUTPUT: {
                ID: systemOutputId,
                STA: on ? 'ON' : 'OFF'
            }
        });

        this.log.info(`💡 Comando luce inviato: Output ${systemOutputId} -> ${on ? 'ON' : 'OFF'}`);
    }

    public async dimLight(lightId: string, brightness: number): Promise<void> {
        if (!this.idLogin) throw new Error('Non connesso');

        const systemOutputId = lightId.replace('light_', '');
        await this.sendKseniaCommand('CMD_USR', 'CMD_SET_OUTPUT', {
            ID_LOGIN: 'true',
            PIN: 'true',
            OUTPUT: {
                ID: systemOutputId,
                STA: brightness.toString()
            }
        });

        this.log.info(`💡 Comando dimmer inviato: Output ${systemOutputId} -> ${brightness}%`);
    }

    public async moveCover(coverId: string, position: number): Promise<void> {
        if (!this.idLogin) throw new Error('Non connesso');

        const systemOutputId = coverId.replace('cover_', '');

        // Determina il comando basato sulla posizione
        let command: string;
        if (position === 0) {
            command = 'DOWN';  // Chiudi
        } else if (position === 100) {
            command = 'UP';    // Apri
        } else {
            command = position.toString(); // Posizione specifica per tapparelle
        }

        await this.sendKseniaCommand('CMD_USR', 'CMD_SET_OUTPUT', {
            ID_LOGIN: 'true',
            PIN: 'true',
            OUTPUT: {
                ID: systemOutputId,
                STA: command
            }
        });

        this.log.info(`🪟 Comando cover inviato: Output ${systemOutputId} -> ${command}`);
    }



    public async setThermostatMode(thermostatId: string, mode: 'off' | 'heat' | 'cool' | 'auto'): Promise<void> {
        if (!this.idLogin) throw new Error('Non connesso');

        let modeValue: string;
        switch (mode) {
            case 'heat': modeValue = '1'; break;
            case 'cool': modeValue = '2'; break;
            case 'auto': modeValue = '3'; break;
            default: modeValue = '0'; break; // off
        }

        await this.sendKseniaCommand('WRITE', 'THERMOSTAT', {
            ID_LOGIN: this.idLogin,
            ID_THERMOSTAT: thermostatId.replace('thermostat_', ''),
            MODE: modeValue
        });
    }

    public async setThermostatTemperature(thermostatId: string, temperature: number): Promise<void> {
        if (!this.idLogin) throw new Error('Non connesso');

        await this.sendKseniaCommand('WRITE', 'THERMOSTAT', {
            ID_LOGIN: this.idLogin,
            ID_THERMOSTAT: thermostatId.replace('thermostat_', ''),
            TARGET_TEMP: temperature.toString()
        });
    }

    public async triggerScenario(scenarioId: string): Promise<void> {
        if (!this.idLogin) throw new Error('Non connesso');

        const systemScenarioId = scenarioId.replace('scenario_', '');
        await this.sendKseniaCommand('CMD_USR', 'CMD_EXE_SCENARIO', {
            ID_LOGIN: 'true',
            PIN: 'true',
            SCENARIO: {
                ID: systemScenarioId
            }
        });
        this.log.info(`🎬 Scenario ${systemScenarioId} eseguito`);
    }

    private async sendKseniaCommand(cmd: string, payloadType: string, payload: any): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket non connesso');
        }

        // Implementa la sostituzione automatica di ID_LOGIN e PIN come fa lares4-ts
        const processedPayload = this.buildPayload(payload);

        const id = Math.floor(Math.random() * 100000).toString();
        const timestamp = Math.floor(Date.now() / 1000).toString();

        const message: KseniaMessage = {
            SENDER: this.sender,
            RECEIVER: '',
            CMD: cmd,
            ID: id,
            PAYLOAD_TYPE: payloadType,
            PAYLOAD: processedPayload,
            TIMESTAMP: timestamp,
            CRC_16: '0x0000'
        };

        // Calcola il CRC del messaggio prima di inviarlo
        message.CRC_16 = this.calculateCRC16(JSON.stringify(message));

        const jsonMessage = JSON.stringify(message);

        // Filtra i log di invio per PING/HEARTBEAT
        const isPing = cmd === 'PING' || payloadType === 'HEARTBEAT';

        if (this.options.debug || !isPing) {
            this.log.info(`📤 Invio: ${jsonMessage}`);
        } else {
            this.log.debug(`📤 Debug: ${jsonMessage}`);
        }

        // Log esteso per debugging comandi critici
        if (cmd === 'CMD_USR') {
            this.log.info(`🔧 DEBUG - Comando ${payloadType}: ${JSON.stringify(payload, null, 2)}`);
        }

        this.ws.send(jsonMessage);
    }

    private buildPayload(payload: any): any {
        // Implementa la logica di sostituzione della libreria lares4-ts
        return {
            ...payload,
            ...(payload?.ID_LOGIN === 'true' && { ID_LOGIN: this.idLogin }),
            ...(payload?.PIN === 'true' && { PIN: this.pin }),
        };
    }

    private async sendMessage(message: KseniaMessage): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket non connesso');
        }

        const messageStr = JSON.stringify(message);
        // Mostra sempre i messaggi inviati per debug
        this.log.info(`📤 Invio: ${messageStr}`);

        this.ws.send(messageStr);
    }

    private calculateCRC16(jsonString: string): string {
        const utf8 = [];
        for (let i = 0; i < jsonString.length; i++) {
            const charcode = jsonString.charCodeAt(i);
            if (charcode < 0x80) utf8.push(charcode);
            else if (charcode < 0x800) {
                utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
            } else if (charcode < 0xd800 || charcode >= 0xe000) {
                utf8.push(0xe0 | (charcode >> 12), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
            } else {
                i++;
                const surrogate = 0x10000 + (((charcode & 0x3ff) << 10) | (jsonString.charCodeAt(i) & 0x3f));
                utf8.push(0xf0 | (surrogate >> 18), 0x80 | ((surrogate >> 12) & 0x3f), 0x80 | ((surrogate >> 6) & 0x3f), 0x80 | (surrogate & 0x3f));
            }
        }

        const SEME_CRC_16_JSON = 0xFFFF;
        const GEN_POLY_JSON = 0x1021;
        const CRC_16 = '"CRC_16"';
        const dataLen = jsonString.lastIndexOf(CRC_16) + CRC_16.length + (utf8.length - jsonString.length);

        let crc = SEME_CRC_16_JSON;
        for (let i = 0; i < dataLen; i++) {
            const charCode = utf8[i];
            for (let i_CRC = 0x80; i_CRC; i_CRC >>= 1) {
                const flag_CRC = (crc & 0x8000) ? 1 : 0;
                crc <<= 1;
                crc = (crc & 0xFFFF);
                if (charCode & i_CRC) { crc++; }
                if (flag_CRC) { crc ^= GEN_POLY_JSON; }
            }
        }

        return '0x' + crc.toString(16).padStart(4, '0');
    }

    private startHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }

        this.heartbeatTimer = setInterval(() => {
            if (this.isConnected && this.idLogin) {
                this.sendKseniaCommand('PING', 'HEARTBEAT', {
                    ID_LOGIN: this.idLogin
                }).catch(err => {
                    this.log.error('❌ Errore heartbeat:', err);
                });
            }
        }, this.options.heartbeatInterval);
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(() => {
            this.log.info('🔄 Tentativo riconnessione...');
            this.connect().catch(err => {
                this.log.error('❌ Riconnessione fallita:', err);
                this.scheduleReconnect();
            });
        }, this.options.reconnectInterval);
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

    // Metodo helper per mappare le modalità del termostato
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

    // Nuovo metodo per gestire le temperature del sistema
    private updateSystemTemperatures(systemData: any[]): void {
        systemData.forEach(system => {
            if (this.options.debug) {
                this.log.debug(`🌡️ Dati sistema ${system.ID}: ${JSON.stringify(system)}`);
            }

            if (system.TEMP) {
                const internalTemp = system.TEMP.IN ? parseFloat(system.TEMP.IN.replace('+', '')) : undefined;
                const externalTemp = system.TEMP.OUT ? parseFloat(system.TEMP.OUT.replace('+', '')) : undefined;

                // Log delle temperature solo se sono cambiate significativamente o in debug
                let logTemperatures = this.options.debug;

                // Controlla se ci sono cambiamenti significativi (>= 0.5°C) nei termostati
                if (internalTemp !== undefined) {
                    this.devices.forEach((device, deviceId) => {
                        if (device.type === 'thermostat') {
                            const oldCurrentTemp = (device.status as any).currentTemperature;
                            if (oldCurrentTemp === undefined || Math.abs(oldCurrentTemp - internalTemp) >= 0.5) {
                                logTemperatures = true;
                            }
                        }
                    });
                }

                if (logTemperatures) {
                    this.log.info(`🌡️ Temperature sistema: Interna=${internalTemp}°C, Esterna=${externalTemp}°C`);
                }

                // Aggiorna tutti i termostati con la temperatura interna del sistema
                // (assumendo che i termostati utilizzino la temperatura interna come riferimento)
                if (internalTemp !== undefined) {
                    this.devices.forEach((device, deviceId) => {
                        if (device.type === 'thermostat') {
                            const oldCurrentTemp = (device.status as any).currentTemperature;
                            (device.status as any).currentTemperature = internalTemp;

                            // Se non abbiamo ancora una temperatura target, usiamo quella corrente + 1°C come ragionevole default
                            if ((device.status as any).targetTemperature === undefined || (device.status as any).targetTemperature === null) {
                                (device.status as any).targetTemperature = Math.round(internalTemp + 1);
                                this.log.info(`🌡️ ${device.name}: Impostata temperatura target iniziale a ${(device.status as any).targetTemperature}°C`);
                            }

                            // Log solo per cambiamenti significativi
                            if (oldCurrentTemp === undefined || Math.abs(oldCurrentTemp - internalTemp) >= 0.5) {
                                this.log.info(`🌡️ ${device.name}: Temperatura corrente aggiornata a ${internalTemp}°C`);
                            }

                            this.onDeviceStatusUpdate?.(device);
                        }
                    });
                }
            }
        });
    }
} 