import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { Lares4Platform } from '../platform';
import type { KseniaThermostat } from '../types';

export class ThermostatAccessory {
    private service: Service;
    private device: KseniaThermostat;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.device = accessory.context.device as KseniaThermostat;

        // Imposta le informazioni dell'accessorio
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ksenia')
            .setCharacteristic(this.platform.Characteristic.Model, 'Lares4 Thermostat')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
            .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '2.0.0');

        // Ottieni o crea il servizio Thermostat
        this.service = this.accessory.getService(this.platform.Service.Thermostat)
            || this.accessory.addService(this.platform.Service.Thermostat);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

        // Imposta gli handlers per le caratteristiche obbligatorie
        this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
            .onGet(this.getCurrentHeatingCoolingState.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
            .onSet(this.setTargetHeatingCoolingState.bind(this))
            .onGet(this.getTargetHeatingCoolingState.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .onGet(this.getCurrentTemperature.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
            .onSet(this.setTargetTemperature.bind(this))
            .onGet(this.getTargetTemperature.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
            .onGet(this.getTemperatureDisplayUnits.bind(this));

        // Caratteristiche opzionali
        if (this.device.humidity !== undefined) {
            this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
                .onGet(this.getCurrentRelativeHumidity.bind(this));
        }

        // Imposta i range di temperatura (configurabili)
        const tempDefaults = this.platform.config.temperatureDefaults || {};
        this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
            .setProps({
                minValue: tempDefaults.min || 10,
                maxValue: tempDefaults.max || 38,
                minStep: tempDefaults.step || 0.5,
            });

        // Inizializza i valori delle caratteristiche
        this.updateCharacteristics();
    }

    async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
        // 0 = Off, 1 = Heat, 2 = Cool
        switch (this.device.mode) {
            case 'heat':
                return this.device.currentTemperature < this.device.targetTemperature ? 1 : 0;
            case 'cool':
                return this.device.currentTemperature > this.device.targetTemperature ? 2 : 0;
            default:
                return 0; // Off
        }
    }

    async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
        // 0 = Off, 1 = Heat, 2 = Cool, 3 = Auto
        switch (this.device.mode) {
            case 'heat': return 1;
            case 'cool': return 2;
            case 'auto': return 3;
            default: return 0; // Off
        }
    }

    async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
        const targetState = value as number;
        let newMode: 'off' | 'heat' | 'cool' | 'auto';

        switch (targetState) {
            case 1: newMode = 'heat'; break;
            case 2: newMode = 'cool'; break;
            case 3: newMode = 'auto'; break;
            default: newMode = 'off'; break;
        }

        try {
            await this.platform.wsClient?.setThermostatMode(this.device.id, newMode);
            this.device.mode = newMode;

            this.platform.log.info(`🌡️ ${this.device.name}: Modalità ${newMode}`);

        } catch (error) {
            this.platform.log.error(`❌ Errore controllo termostato ${this.device.name}:`, error);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async getCurrentTemperature(): Promise<CharacteristicValue> {
        // Se non abbiamo una temperatura valida, ritorna un valore che indica "dati non disponibili"
        if (this.device.currentTemperature === undefined || this.device.currentTemperature === null) {
            this.platform.log.warn(`⚠️ ${this.device.name}: Temperatura corrente non disponibile`);
            return 0; // Valore che indica dati non disponibili invece di 20°C hardcoded
        }
        return Math.max(-270, Math.min(100, this.device.currentTemperature));
    }

    async getTargetTemperature(): Promise<CharacteristicValue> {
        // Se non abbiamo una temperatura target valida, usa un valore di default ragionevole
        if (this.device.targetTemperature === undefined || this.device.targetTemperature === null) {
            const defaultTemp = this.platform.config.temperatureDefaults?.target || 21;
            this.platform.log.warn(`⚠️ ${this.device.name}: Temperatura target non disponibile, usando ${defaultTemp}°C come default`);
            return defaultTemp;
        }
        return this.device.targetTemperature;
    }

    async setTargetTemperature(value: CharacteristicValue): Promise<void> {
        const targetTemperature = value as number;

        try {
            await this.platform.wsClient?.setThermostatTemperature(this.device.id, targetTemperature);
            this.device.targetTemperature = targetTemperature;

            this.platform.log.info(`🌡️ ${this.device.name}: Temperatura target ${targetTemperature}°C`);

        } catch (error) {
            this.platform.log.error(`❌ Errore impostazione temperatura ${this.device.name}:`, error);
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
        return 0; // Celsius
    }

    async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
        if (this.device.humidity !== undefined) {
            return Math.max(0, Math.min(100, this.device.humidity));
        }
        return 50; // Default value
    }

    private updateCharacteristics(): void {
        // Usa valori sincroni per l'inizializzazione
        let currentState = 0; // Off
        switch (this.device.mode) {
            case 'heat':
                currentState = this.device.currentTemperature < this.device.targetTemperature ? 1 : 0;
                break;
            case 'cool':
                currentState = this.device.currentTemperature > this.device.targetTemperature ? 2 : 0;
                break;
        }

        let targetState = 0; // Off
        switch (this.device.mode) {
            case 'heat': targetState = 1; break;
            case 'cool': targetState = 2; break;
            case 'auto': targetState = 3; break;
        }

        this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, currentState);
        this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, targetState);

        // Gestione migliorata per i valori di temperatura
        const currentTemp = this.device.currentTemperature !== undefined && this.device.currentTemperature !== null
            ? Math.max(-270, Math.min(100, this.device.currentTemperature))
            : 0; // Valore che indica dati non disponibili

        const defaultTemp = this.platform.config.temperatureDefaults?.target || 21;
        const targetTemp = this.device.targetTemperature !== undefined && this.device.targetTemperature !== null
            ? this.device.targetTemperature
            : defaultTemp; // Default configurabile quando non disponibile

        this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, currentTemp);
        this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, targetTemp);

        if (this.device.humidity !== undefined) {
            this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, Math.max(0, Math.min(100, this.device.humidity)));
        }
    }

    // Metodo per aggiornare lo stato dall'esterno (aggiornamenti real-time)
    updateStatus(newDevice: KseniaThermostat): void {
        const oldDevice = this.device;
        this.device = newDevice;

        // Aggiorna le caratteristiche solo se necessario
        if (oldDevice.currentTemperature !== newDevice.currentTemperature) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.CurrentTemperature,
                Math.max(-270, Math.min(100, newDevice.currentTemperature))
            );
        }

        if (oldDevice.targetTemperature !== newDevice.targetTemperature) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.TargetTemperature,
                newDevice.targetTemperature
            );
        }

        if (oldDevice.mode !== newDevice.mode) {
            let targetState = 0;
            switch (newDevice.mode) {
                case 'heat': targetState = 1; break;
                case 'cool': targetState = 2; break;
                case 'auto': targetState = 3; break;
            }

            let currentState = 0;
            switch (newDevice.mode) {
                case 'heat':
                    currentState = newDevice.currentTemperature < newDevice.targetTemperature ? 1 : 0;
                    break;
                case 'cool':
                    currentState = newDevice.currentTemperature > newDevice.targetTemperature ? 2 : 0;
                    break;
            }

            this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, targetState);
            this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, currentState);
        }

        if (oldDevice.humidity !== newDevice.humidity && newDevice.humidity !== undefined) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.CurrentRelativeHumidity,
                Math.max(0, Math.min(100, newDevice.humidity))
            );
        }

        this.platform.log.debug(`🔄 Aggiornato termostato ${this.device.name}: ${this.device.currentTemperature}°C → ${this.device.targetTemperature}°C (${this.device.mode})`);
    }
} 