import type {
    DomusThermostatManualCommandPair,
    DomusThermostatManualPair,
    RoomConfig,
    RoomDevice,
} from '../types';
import { cite, ConfigIssues, isPlainObject, readBoolean, readNumber, readString, typeName } from './config-values';
import { limit } from './runtime-config-limits';
import type { MatterExposureConfig } from './types';

export const MATTER_EXPOSURE_KEYS = [
    'zones', 'sensors', 'scenarios', 'lights', 'covers', 'gates', 'thermostats',
] as const satisfies ReadonlyArray<keyof MatterExposureConfig>;

export interface ResolvedMatterExposure {
    /** Every category, exposed unless explicitly set to false. */
    exposure: Record<(typeof MATTER_EXPOSURE_KEYS)[number], boolean>;
    /** Categories the user set explicitly (to tell "category" from "default" in the policy). */
    explicit: ReadonlySet<keyof MatterExposureConfig>;
}

function objectSection(raw: unknown, key: string, issues: ConfigIssues): Record<string, unknown> {
    if (isPlainObject(raw)) return raw;
    if (raw !== undefined && raw !== null) {
        issues.warn(key, `expected an object, received ${typeName(raw)}; using the defaults`);
    }
    return {};
}

export function resolveMatterExposure(raw: unknown, issues: ConfigIssues): ResolvedMatterExposure {
    const section = objectSection(raw, 'matterExposure', issues);
    const explicit = new Set<keyof MatterExposureConfig>();
    const read = (key: keyof MatterExposureConfig): boolean => {
        if (typeof section[key] === 'boolean') explicit.add(key);
        return readBoolean(section[key], true, `matterExposure.${key}`, issues);
    };
    const [zones, sensors, scenarios, lights, covers, gates, thermostats] = MATTER_EXPOSURE_KEYS.map(read);
    return { exposure: { zones, sensors, scenarios, lights, covers, gates, thermostats }, explicit };
}

export function resolveTemperatureDefaults(raw: unknown, issues: ConfigIssues): {
    target: number; min: number; max: number; step: number;
} {
    const section = objectSection(raw, 'temperatureDefaults', issues);
    const read = (field: 'target' | 'min' | 'max' | 'step'): number =>
        readNumber(section[field], limit(`temperatureDefaults.${field}`), `temperatureDefaults.${field}`, issues);
    return { target: read('target'), min: read('min'), max: read('max'), step: read('step') };
}

/** An ID written as a string, or as an integer the user forgot to quote. */
function idText(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPairs<T>(
    raw: unknown,
    key: string,
    fields: readonly [string, string],
    build: (first: string, second: string) => T,
    issues: ConfigIssues,
): T[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        issues.warn(key, `expected an array, received ${typeName(raw)}; ignoring it`);
        return [];
    }
    const pairs: T[] = [];
    raw.forEach((row: unknown, index: number): void => {
        const first = isPlainObject(row) ? idText(row[fields[0]]) : undefined;
        const second = isPlainObject(row) ? idText(row[fields[1]]) : undefined;
        if (first !== undefined && second !== undefined) pairs.push(build(first, second));
        else if (isPlainObject(row) && Object.values(row).every((v) => v === undefined || v === null || v === '')) return;
        else issues.warn(`${key}[${index}]`, `needs ${fields[0]} and ${fields[1]}; ignoring the row`);
    });
    return pairs;
}

export interface ResolvedDomusThermostat {
    enabled: boolean;
    sensorFreshnessMs: number;
    manualPairs: DomusThermostatManualPair[];
    manualCommandPairs: DomusThermostatManualCommandPair[];
}

export function resolveDomusThermostat(raw: unknown, issues: ConfigIssues): ResolvedDomusThermostat {
    const section = objectSection(raw, 'domusThermostat', issues);
    return {
        enabled: readBoolean(section.enabled, true, 'domusThermostat.enabled', issues),
        sensorFreshnessMs: readNumber(
            section.sensorFreshnessMs,
            limit('domusThermostat.sensorFreshnessMs'),
            'domusThermostat.sensorFreshnessMs',
            issues,
        ),
        manualPairs: readPairs(
            section.manualPairs, 'domusThermostat.manualPairs', ['thermostatOutputId', 'domusSensorId'],
            (thermostatOutputId, domusSensorId) => ({ thermostatOutputId, domusSensorId }), issues,
        ),
        manualCommandPairs: readPairs(
            section.manualCommandPairs, 'domusThermostat.manualCommandPairs', ['thermostatOutputId', 'commandThermostatId'],
            (thermostatOutputId, commandThermostatId) => ({ thermostatOutputId, commandThermostatId }), issues,
        ),
    };
}

export interface ResolvedKsaImport {
    enabled: boolean;
    filePath?: string;
    applyAtStartup: boolean;
    applyDomusMappings: boolean;
    applyRoomMapping: boolean;
    applyCustomNames: boolean;
    applyExclusionSuggestions: boolean;
}

export function resolveKsaImport(raw: unknown, issues: ConfigIssues): ResolvedKsaImport {
    const section = objectSection(raw, 'ksaImport', issues);
    const flag = (key: string, defaultValue: boolean): boolean =>
        readBoolean(section[key], defaultValue, `ksaImport.${key}`, issues);
    const filePath = readString(section.filePath, 'ksaImport.filePath', issues);
    return {
        enabled: flag('enabled', false),
        ...(filePath !== undefined ? { filePath } : {}),
        applyAtStartup: flag('applyAtStartup', false),
        applyDomusMappings: flag('applyDomusMappings', true),
        applyRoomMapping: flag('applyRoomMapping', true),
        applyCustomNames: flag('applyCustomNames', false),
        applyExclusionSuggestions: flag('applyExclusionSuggestions', false),
    };
}

export interface ResolvedRoomMapping {
    enabled: boolean;
    rooms: RoomConfig[];
}

function readRoomDevices(raw: unknown, where: string, issues: ConfigIssues): RoomDevice[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        issues.warn(`${where}.devices`, `expected an array, received ${typeName(raw)}; ignoring it`);
        return [];
    }
    const devices: RoomDevice[] = [];
    for (const row of raw) {
        const deviceId = isPlainObject(row) ? idText(row.deviceId) : undefined;
        if (deviceId === undefined) {
            if (!isPlainObject(row) || Object.values(row).some((v) => v !== undefined && v !== null && v !== '')) {
                issues.warn(`${where}.devices`, `${cite(row)} has no deviceId; ignoring it`);
            }
            continue;
        }
        const deviceName = isPlainObject(row) && typeof row.deviceName === 'string' ? row.deviceName : undefined;
        devices.push(deviceName === undefined ? { deviceId } : { deviceId, deviceName });
    }
    return devices;
}

export function resolveRoomMapping(raw: unknown, issues: ConfigIssues): ResolvedRoomMapping {
    const section = objectSection(raw, 'roomMapping', issues);
    const enabled = readBoolean(section.enabled, false, 'roomMapping.enabled', issues);
    const rooms: RoomConfig[] = [];
    if (Array.isArray(section.rooms)) {
        section.rooms.forEach((row: unknown, index: number): void => {
            const where = `roomMapping.rooms[${index}]`;
            if (!isPlainObject(row)) {
                issues.warn(where, `expected an object, received ${typeName(row)}; ignoring the room`);
                return;
            }
            // Kept as written: the room name is part of the MQTT topic.
            if (typeof row.roomName !== 'string' || !row.roomName.trim()) {
                // The UI's empty row (no name, no devices) is not worth a warning.
                const empty = Object.values(row).every(
                    (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0),
                );
                if (!empty) issues.warn(where, 'needs a roomName; ignoring the room');
                return;
            }
            rooms.push({ roomName: row.roomName, devices: readRoomDevices(row.devices, where, issues) });
        });
    } else if (section.rooms !== undefined && section.rooms !== null) {
        issues.warn('roomMapping.rooms', `expected an array, received ${typeName(section.rooms)}; ignoring it`);
    }
    return { enabled, rooms };
}
