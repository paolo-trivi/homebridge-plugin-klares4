import type { KseniaDevice } from './types';

export const DEVICE_ID_PREFIXES = [
    'light_',
    'cover_',
    'gate_',
    'sensor_temp_',
    'sensor_hum_',
    'sensor_light_',
    'zone_',
    'thermostat_',
    'scenario_',
] as const;

export type DeviceIdPrefix = (typeof DEVICE_ID_PREFIXES)[number];

const DEVICE_ID_PREFIXES_BY_LENGTH = [...DEVICE_ID_PREFIXES].sort((a, b) => b.length - a.length);

export const ROOM_MAPPING_DEVICE_ID_PATTERN =
    '^(light_|cover_|gate_|zone_|thermostat_|scenario_)[0-9]+$|^sensor_(temp|hum|light)_[0-9]+$|^sensor_system_temp_(in|out)$';

export function parseDeviceId(deviceId: string): { prefix: DeviceIdPrefix | null; rawId: string } {
    for (const prefix of DEVICE_ID_PREFIXES_BY_LENGTH) {
        if (deviceId.startsWith(prefix)) {
            return {
                prefix,
                rawId: deviceId.slice(prefix.length),
            };
        }
    }

    return {
        prefix: null,
        rawId: deviceId,
    };
}

export function stripDevicePrefix(deviceId: string): string {
    return parseDeviceId(deviceId).rawId;
}

export function buildDeviceId(prefix: DeviceIdPrefix, rawId: string | number): string {
    return `${prefix}${String(rawId)}`;
}

export function isOutputLikeDevice(device: KseniaDevice): boolean {
    return (
        device.type === 'light' ||
        device.type === 'cover' ||
        device.type === 'gate' ||
        device.type === 'thermostat'
    );
}
