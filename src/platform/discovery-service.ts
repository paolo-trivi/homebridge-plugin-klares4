import type { Logger } from 'homebridge';
import type { KseniaDevice } from '../types';
import { isOutputLikeDevice, stripDevicePrefix } from '../device-id';
import type { Lares4Config } from './types';

export class DiscoveryService {
    constructor(
        private readonly config: Lares4Config,
        private readonly log: Logger,
    ) {}

    public getNormalizedId(deviceId: string): string {
        return stripDevicePrefix(deviceId);
    }

    public shouldExcludeDevice(device: KseniaDevice): boolean {
        const id = this.getNormalizedId(device.id);

        if (device.type === 'zone' && this.config.excludeZones?.includes(id)) {
            this.log.info(`Zone excluded: ${device.name} (ID: ${id})`);
            return true;
        }

        if (isOutputLikeDevice(device) && this.config.excludeOutputs?.includes(id)) {
            this.log.info(`Output excluded: ${device.name} (ID: ${id})`);
            return true;
        }

        if (device.type === 'sensor' && this.config.excludeSensors?.includes(id)) {
            this.log.info(`Sensor excluded: ${device.name} (ID: ${id})`);
            return true;
        }

        if (device.type === 'scenario' && this.config.excludeScenarios?.includes(id)) {
            this.log.info(`Scenario excluded: ${device.name} (ID: ${id})`);
            return true;
        }

        return false;
    }

    public getCustomName(device: KseniaDevice): string | undefined {
        const id = this.getNormalizedId(device.id);

        if (device.type === 'zone') {
            return this.config.customNames?.zones?.[id];
        }

        if (isOutputLikeDevice(device)) {
            return this.config.customNames?.outputs?.[id];
        }

        if (device.type === 'sensor') {
            const sensorName = this.config.customNames?.sensors?.[id];
            if (sensorName) {
                if (device.id.includes('_temp_')) return `${sensorName} - Temperatura`;
                if (device.id.includes('_hum_')) return `${sensorName} - Umidita`;
                if (device.id.includes('_light_')) return `${sensorName} - Luminosita`;
            }
        }

        if (device.type === 'scenario') {
            return this.config.customNames?.scenarios?.[id];
        }

        return undefined;
    }

    public applyCustomName(device: KseniaDevice): KseniaDevice {
        const customName = this.getCustomName(device);
        if (!customName) {
            return device;
        }

        const mutableDevice = device as { name: string; description: string };
        mutableDevice.name = customName;
        mutableDevice.description = customName;
        return device;
    }
}
