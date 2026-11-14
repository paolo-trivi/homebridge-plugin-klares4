import type { Logger, PlatformAccessory } from 'homebridge';

import { CoverAccessory } from '../accessories/cover-accessory';
import { GateAccessory } from '../accessories/gate-accessory';
import { LightAccessory } from '../accessories/light-accessory';
import { ScenarioAccessory } from '../accessories/scenario-accessory';
import { SensorAccessory } from '../accessories/sensor-accessory';
import { ThermostatAccessory } from '../accessories/thermostat-accessory';
import { ZoneAccessory } from '../accessories/zone-accessory';
import type { KseniaDevice } from '../types';
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
                handler = new ScenarioAccessory(this.platform, accessory, device);
                this.log.debug(`Created handler for scenario: ${device.name}`);
                break;
            default:
                this.log.warn(`Unsupported device type: ${(device as KseniaDevice).type}`);
                return undefined;
        }

        return handler;
    }

    /** Hands the new state of a device to its handler; a handler of another kind is left alone. */
    public updateAccessoryHandler(handler: AccessoryHandler, device: KseniaDevice): void {
        switch (device.type) {
            case 'light':
                if (handler instanceof LightAccessory) handler.updateStatus(device);
                break;
            case 'cover':
                if (handler instanceof CoverAccessory) handler.updateStatus(device);
                break;
            case 'thermostat':
                if (handler instanceof ThermostatAccessory) handler.updateStatus(device);
                break;
            case 'sensor':
                if (handler instanceof SensorAccessory) handler.updateStatus(device);
                break;
            case 'zone':
                if (handler instanceof ZoneAccessory) handler.updateStatus(device);
                break;
            case 'gate':
                if (handler instanceof GateAccessory) handler.updateDevice(device);
                break;
            case 'scenario':
                if (handler instanceof ScenarioAccessory) handler.updateDevice(device);
                break;
        }
    }
}
