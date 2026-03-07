import type { Logger, PlatformAccessory } from 'homebridge';

import { CoverAccessory } from '../accessories/cover-accessory';
import { GateAccessory } from '../accessories/gate-accessory';
import { LightAccessory } from '../accessories/light-accessory';
import { ScenarioAccessory } from '../accessories/scenario-accessory';
import { SensorAccessory } from '../accessories/sensor-accessory';
import { ThermostatAccessory } from '../accessories/thermostat-accessory';
import { ZoneAccessory } from '../accessories/zone-accessory';
import type {
    KseniaCover,
    KseniaDevice,
    KseniaGate,
    KseniaLight,
    KseniaScenario,
    KseniaSensor,
    KseniaThermostat,
    KseniaZone,
} from '../types';
import type { Lares4Platform } from './index';
import type { AccessoryHandler } from './types';

export class AccessoryHandlerService {
    constructor(
        private readonly platform: Lares4Platform,
        private readonly log: Logger,
    ) {}

    public createAccessoryHandler(
        accessory: PlatformAccessory,
        device: KseniaDevice,
    ): AccessoryHandler | undefined {
        let handler: AccessoryHandler | undefined;

        switch (device.type) {
            case 'light':
                handler = new LightAccessory(this.platform, accessory);
                this.log.debug(`Created handler for light: ${device.name}`);
                break;
            case 'cover':
                handler = new CoverAccessory(this.platform, accessory);
                this.log.debug(`Created handler for cover: ${device.name}`);
                break;
            case 'gate':
                handler = new GateAccessory(this.platform, accessory);
                this.log.debug(`Created handler for gate: ${device.name}`);
                break;
            case 'sensor':
                handler = new SensorAccessory(this.platform, accessory);
                this.log.debug(`Created handler for sensor: ${device.name}`);
                break;
            case 'zone':
                handler = new ZoneAccessory(this.platform, accessory);
                this.log.debug(`Created handler for zone: ${device.name}`);
                break;
            case 'thermostat':
                handler = new ThermostatAccessory(this.platform, accessory);
                this.log.debug(`Created handler for thermostat: ${device.name}`);
                break;
            case 'scenario':
                handler = new ScenarioAccessory(this.platform, accessory, device as KseniaScenario);
                this.log.debug(`Created handler for scenario: ${device.name}`);
                break;
            default:
                this.log.warn(`Unsupported device type: ${(device as KseniaDevice).type}`);
                return undefined;
        }

        return handler;
    }

    public updateAccessoryHandler(handler: AccessoryHandler, device: KseniaDevice): void {
        if (
            device.type === 'gate' &&
            'updateDevice' in handler &&
            typeof handler.updateDevice === 'function'
        ) {
            handler.updateDevice(device as KseniaGate);
            return;
        }

        if (!('updateStatus' in handler) || typeof handler.updateStatus !== 'function') {
            return;
        }

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
            case 'gate':
                break;
        }
    }
}
