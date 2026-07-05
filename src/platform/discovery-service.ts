import type { Logger } from 'homebridge';
import type { KseniaDevice } from '../types';
import { isOutputLikeDevice, stripDevicePrefix } from '../device-id';
import type { Lares4Config, MatterExposureConfig } from './types';

/** Lares4 device.type → matterExposure config key. */
const MATTER_EXPOSURE_KEYS: Record<string, keyof MatterExposureConfig> = {
    zone: 'zones',
    sensor: 'sensors',
    scenario: 'scenarios',
    light: 'lights',
    cover: 'covers',
    gate: 'gates',
    thermostat: 'thermostats',
};

export class DiscoveryService {
    constructor(
        private readonly config: Lares4Config,
        private readonly log: Logger,
    ) {}

    public getNormalizedId(deviceId: string): string {
        return stripDevicePrefix(deviceId);
    }

    /**
     * Quiet variant of `shouldExcludeDevice`: same config rules, no logging.
     * Safe to call on hot paths (per-status-update Matter eligibility checks).
     */
    public isDeviceExcluded(device: KseniaDevice): boolean {
        const id = this.getNormalizedId(device.id);

        if (device.type === 'zone') return this.config.excludeZones?.includes(id) ?? false;
        if (isOutputLikeDevice(device)) return this.config.excludeOutputs?.includes(id) ?? false;
        if (device.type === 'sensor') return this.config.excludeSensors?.includes(id) ?? false;
        if (device.type === 'scenario') return this.config.excludeScenarios?.includes(id) ?? false;
        return false;
    }

    public shouldExcludeDevice(device: KseniaDevice): boolean {
        if (!this.isDeviceExcluded(device)) return false;

        const id = this.getNormalizedId(device.id);
        const label = device.type === 'zone' ? 'Zone'
            : isOutputLikeDevice(device) ? 'Output'
                : device.type === 'sensor' ? 'Sensor'
                    : 'Scenario';
        this.log.info(`${label} excluded: ${device.name} (ID: ${id})`);
        return true;
    }

    /**
     * Per-type Matter exposure (`matterExposure` config). Default: everything
     * exposed. Affects ONLY the Matter side — HAP accessories and the MQTT
     * bridge keep publishing every device.
     */
    public isMatterTypeExposed(deviceType: string): boolean {
        const key = MATTER_EXPOSURE_KEYS[deviceType];
        if (!key) return true;
        return this.config.matterExposure?.[key] !== false;
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
