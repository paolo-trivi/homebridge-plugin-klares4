import type { Logger } from 'homebridge';
import type { KseniaDevice } from '../types';
import { isOutputLikeDevice, stripDevicePrefix } from '../device-id';
import type {
    Lares4Config,
    MatterDeviceOverride,
    MatterExposureConfig,
    ResolvedDeviceNames,
    ResolvedMatterPolicy,
} from './types';
import { ConfigIssues, hasOwn } from './config-values';
import { isSystemSensorId, lookupCustomName, normalizeCustomNames, type CustomNamesMap } from './custom-names-config';
import { EXCLUSION_LISTS, normalizeExclusionList, type ExclusionKey } from './exclusion-lists';
import { resolveRuntimeConfig, type RuntimeConfig } from './runtime-config';

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

interface Snapshot<T> {
    /** The config value `value` was derived from; a different one means the config was replaced. */
    source: unknown;
    value: T;
}

export class DiscoveryService {
    /** Exclusion lists, as sets of panel IDs; re-derived if the KSA import replaces a list. */
    private readonly exclusions = new Map<ExclusionKey, Snapshot<ReadonlySet<string>>>();
    /** `customNames` resolved to the category map; re-derived if the KSA import replaces it. */
    private customNamesSnapshot: Snapshot<CustomNamesMap>;

    /**
     * Reads the validated values of `runtime`; without it the config is
     * validated here (and its problems reported on `log`), which is what a
     * standalone service handed a raw config needs.
     */
    constructor(
        private readonly config: Lares4Config,
        private readonly log: Logger,
        private readonly runtime: RuntimeConfig = resolveRuntimeConfig(config, log),
    ) {
        for (const key of Object.keys(EXCLUSION_LISTS) as ExclusionKey[]) {
            this.exclusions.set(key, { source: config[key], value: new Set(runtime.exclusions[key]) });
        }
        this.customNamesSnapshot = { source: config.customNames, value: runtime.customNames };
    }

    public getNormalizedId(deviceId: string): string {
        return stripDevicePrefix(deviceId);
    }

    /**
     * Quiet variant of `shouldExcludeDevice`: same config rules, no logging.
     * Safe to call on hot paths (per-status-update Matter eligibility checks).
     */
    public isDeviceExcluded(device: KseniaDevice): boolean {
        const id = this.getNormalizedId(device.id);

        if (device.type === 'zone') return this.exclusionIds('excludeZones').has(id);
        if (isOutputLikeDevice(device)) return this.exclusionIds('excludeOutputs').has(id);
        if (device.type === 'sensor') return this.exclusionIds('excludeSensors').has(id);
        if (device.type === 'scenario') return this.exclusionIds('excludeScenarios').has(id);
        return false;
    }

    private exclusionIds(key: ExclusionKey): ReadonlySet<string> {
        const snapshot = this.exclusions.get(key);
        const current: unknown = this.config[key];
        if (snapshot && snapshot.source === current) return snapshot.value;
        const value: ReadonlySet<string> = new Set(normalizeExclusionList(current, key, new ConfigIssues()));
        this.exclusions.set(key, { source: current, value });
        return value;
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
        return this.runtime.matterExposure[key];
    }

    public resolveMatterPolicy(device: KseniaDevice): ResolvedMatterPolicy {
        const names = this.resolveDeviceNames(device);
        if (this.isDeviceExcluded(device)) {
            return { exposed: false, displayName: names.matterName, exposureSource: 'global-exclusion', names };
        }
        const override = this.matterOverride(device.id);
        if (typeof override?.exposed === 'boolean') {
            return {
                exposed: override.exposed,
                displayName: names.matterName,
                exposureSource: 'device-override',
                names,
            };
        }
        const key = MATTER_EXPOSURE_KEYS[device.type];
        if (key && this.runtime.matterExposureExplicit.has(key)) {
            return {
                exposed: this.runtime.matterExposure[key],
                displayName: names.matterName,
                exposureSource: 'category',
                names,
            };
        }
        return { exposed: true, displayName: names.matterName, exposureSource: 'default', names };
    }

    public resolveDeviceNames(device: KseniaDevice): ResolvedDeviceNames {
        const sourceName = device.name;
        const customName = this.getCustomName(device);
        const configuredOverride = this.matterOverride(device.id)?.name;
        const matterOverrideName = typeof configuredOverride === 'string' && configuredOverride.trim()
            ? configuredOverride.trim()
            : undefined;
        const effectiveSharedName = customName ?? sourceName;
        return {
            sourceName,
            customName,
            effectiveSharedName,
            matterOverrideName,
            matterName: matterOverrideName ?? effectiveSharedName,
            nameSource: matterOverrideName ? 'matter-override' : customName ? 'custom-name' : 'source',
        };
    }

    /** Own-property lookup: a panel ID such as `constructor` has no override. */
    private matterOverride(deviceId: string): MatterDeviceOverride | undefined {
        return hasOwn(this.runtime.matterOverrides, deviceId) ? this.runtime.matterOverrides[deviceId] : undefined;
    }

    private customNames(): CustomNamesMap {
        if (this.config.customNames !== this.customNamesSnapshot.source) {
            this.customNamesSnapshot = {
                source: this.config.customNames,
                value: normalizeCustomNames(this.config.customNames),
            };
        }
        return this.customNamesSnapshot.value;
    }

    public getCustomName(device: KseniaDevice): string | undefined {
        const id = this.getNormalizedId(device.id);
        const customNames = this.customNames();

        if (device.type === 'zone') {
            return lookupCustomName(customNames.zones, id);
        }

        if (isOutputLikeDevice(device)) {
            return lookupCustomName(customNames.outputs, id);
        }

        if (device.type === 'sensor') {
            const sensorName = lookupCustomName(customNames.sensors, id);
            // A panel temperature sensor is a single reading: its name is used as-is.
            if (sensorName && isSystemSensorId(id)) return sensorName;
            if (sensorName) {
                if (device.id.includes('_temp_')) return `${sensorName} - Temperatura`;
                if (device.id.includes('_hum_')) return `${sensorName} - Umidita`;
                if (device.id.includes('_light_')) return `${sensorName} - Luminosita`;
            }
        }

        if (device.type === 'scenario') {
            return lookupCustomName(customNames.scenarios, id);
        }

        return undefined;
    }

    public applyCustomName(device: KseniaDevice): KseniaDevice {
        const customName = this.getCustomName(device);
        if (!customName) {
            return device;
        }

        return { ...device, name: customName, description: customName } as KseniaDevice;
    }

    public applyMatterName(device: KseniaDevice): KseniaDevice {
        const displayName = this.resolveMatterPolicy(device).displayName;
        if (displayName === device.name) return device;
        return { ...device, name: displayName, description: displayName } as KseniaDevice;
    }
}
