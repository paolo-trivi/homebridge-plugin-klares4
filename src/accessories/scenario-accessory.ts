import type {
    Service,
    PlatformAccessory,
    CharacteristicValue,
} from 'homebridge';

import { Lares4Platform } from '../platform';
import { KseniaDevice } from '../types';

export class ScenarioAccessory {
    private service: Service;

    constructor(
        private readonly platform: Lares4Platform,
        private readonly accessory: PlatformAccessory,
        private readonly device: KseniaDevice,
    ) {
        // Imposta le informazioni dell'accessorio
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ksenia')
            .setCharacteristic(this.platform.Characteristic.Model, 'Lares4 Scenario')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, device.id);

        // Ottieni il servizio Switch o crealo se non esiste
        this.service = this.accessory.getService(this.platform.Service.Switch) ||
            this.accessory.addService(this.platform.Service.Switch);

        // Imposta il nome del servizio
        this.service.setCharacteristic(this.platform.Characteristic.Name, device.name);

        // Registra gli handler per le caratteristiche
        this.service.getCharacteristic(this.platform.Characteristic.On)
            .onSet(this.setOn.bind(this))
            .onGet(this.getOn.bind(this));
    }

    async setOn(value: CharacteristicValue) {
        const isOn = value as boolean;

        if (isOn) {
            try {
                if (!this.platform.wsClient) {
                    throw new Error('WebSocket client non inizializzato');
                }
                await this.platform.wsClient.triggerScenario(this.device.id);
                this.platform.log.info(`🎬 Scenario ${this.device.name} eseguito`);

                // Spegni automaticamente dopo timeout configurabile (gli scenari sono momentanei)
                const autoOffDelay = this.platform.config.scenarioAutoOffDelay || 500;
                setTimeout(() => {
                    if (this.service) {
                        this.service.updateCharacteristic(this.platform.Characteristic.On, false);
                        this.platform.log.debug(`🔄 Scenario ${this.device.name} automaticamente spento dopo ${autoOffDelay}ms`);
                    }
                }, autoOffDelay);

            } catch (error) {
                this.platform.log.error(`❌ Errore esecuzione scenario ${this.device.name}:`, error);
                throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        }
        // Non facciamo nulla per "spegnere" uno scenario
    }

    async getOn(): Promise<CharacteristicValue> {
        // Gli scenari non hanno uno stato persistente, tornano sempre false
        return false;
    }
} 