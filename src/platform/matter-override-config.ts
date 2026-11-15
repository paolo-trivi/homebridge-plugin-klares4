import { cite, ConfigIssues, hasOwn, isPlainObject, setOwn, typeName } from './config-values';
import type { MatterDeviceOverride } from './types';

/**
 * Array form of a per-device override, e.g.
 * `[{ "deviceId": "zone_18", "name": "Contatto Studio" }]`.
 *
 * The Homebridge UI rebuilds `config.json` from its form model and silently
 * drops object-typed keys whose properties it cannot render — a free-form map
 * keyed by device ID is exactly that shape, so saving any unrelated setting
 * from the UI used to delete the whole `matterOverrides` block. An array of
 * typed items renders and round-trips, so it is the form the UI preserves.
 */
export interface MatterDeviceOverrideEntry extends MatterDeviceOverride {
    deviceId?: string;
}

export interface MatterRecoveryRequestEntry {
    deviceId?: string;
    generation?: number;
}

export type MatterOverridesConfig =
    | Record<string, MatterDeviceOverride>
    | MatterDeviceOverrideEntry[];

export type MatterRecoveryRequestsConfig =
    | Record<string, number>
    | MatterRecoveryRequestEntry[];

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

interface RawRow {
    /** Where the row is in the config, for the warnings. */
    where: string;
    row: unknown;
}

/**
 * Rows of either accepted form. The legacy map is keyed by device ID:
 * `mapRow` turns one `[id, value]` pair into the equivalent array row, so both
 * forms go through the same validation.
 */
function toRows(
    configured: unknown,
    key: string,
    mapRow: (deviceId: string, value: unknown) => unknown,
    issues: ConfigIssues,
): RawRow[] {
    if (Array.isArray(configured)) {
        return configured.map((row: unknown, index: number): RawRow => ({ where: `${key}[${index}]`, row }));
    }
    if (!isPlainObject(configured)) {
        issues.warn(key, `expected an array of { deviceId, ... }, received ${typeName(configured)}; ignoring it`);
        return [];
    }
    return Object.keys(configured).map((deviceId: string): RawRow => ({
        where: `${key}.${deviceId}`,
        row: mapRow(deviceId, configured[deviceId]),
    }));
}

/** The trimmed device ID of a row, or undefined for a row that names no device (the UI's empty row). */
function rowDeviceId(row: Record<string, unknown>): string | undefined {
    return isNonEmptyString(row.deviceId) ? row.deviceId.trim() : undefined;
}

function mergeOverride(
    into: MatterDeviceOverride,
    from: MatterDeviceOverride,
    deviceId: string,
    issues: ConfigIssues,
): void {
    for (const field of ['name', 'exposed'] as const) {
        const value = from[field];
        if (value === undefined) continue;
        if (into[field] !== undefined && into[field] !== value) {
            issues.warn('matterOverrides', `${cite(deviceId)} sets ${field} in more than one row with different values; the last row wins`);
        }
        Object.assign(into, { [field]: value });
    }
}

/**
 * Accepts either form and always yields a map keyed by device ID, validating
 * both with the same rules. A row that is not an object, has no usable
 * `deviceId`, or carries a `name`/`exposed` of the wrong type is dropped (or
 * loses that field) and reported: a malformed row must not stop the platform
 * from starting. Rows for the same `deviceId` (compared exactly, after trim)
 * are merged, so one row that hides a device and another that names it both
 * apply.
 */
export function normalizeMatterOverrides(
    configured: unknown,
    issues: ConfigIssues = new ConfigIssues(),
): Record<string, MatterDeviceOverride> {
    const normalized: Record<string, MatterDeviceOverride> = {};
    if (configured === undefined || configured === null) return normalized;
    for (const { where, row } of toRows(configured, 'matterOverrides', (deviceId, value) => (isPlainObject(value) ? { ...value, deviceId } : value), issues)) {
        if (!isPlainObject(row)) {
            issues.warn(where, `expected an object with deviceId, name and/or exposed, received ${typeName(row)}; ignoring it`);
            continue;
        }
        const deviceId = rowDeviceId(row);
        if (!deviceId) {
            if (row.deviceId !== undefined && row.deviceId !== null && typeof row.deviceId !== 'string') {
                issues.warn(where, `deviceId must be a string, received ${typeName(row.deviceId)}; ignoring the row`);
            }
            continue;
        }
        const override: MatterDeviceOverride = {};
        if (isNonEmptyString(row.name)) override.name = row.name.trim();
        else if (row.name !== undefined && row.name !== null && typeof row.name !== 'string') {
            issues.warn(where, `the name of ${cite(deviceId)} must be a string, received ${typeName(row.name)}; ignoring it`);
        }
        if (typeof row.exposed === 'boolean') override.exposed = row.exposed;
        else if (row.exposed !== undefined && row.exposed !== null) {
            issues.warn(where, `exposed of ${cite(deviceId)} must be true or false, received ${typeName(row.exposed)}; ignoring it`);
        }
        if (override.name === undefined && override.exposed === undefined) continue;
        const merged: MatterDeviceOverride = (hasOwn(normalized, deviceId) ? normalized[deviceId] : undefined) ?? {};
        mergeOverride(merged, override, deviceId, issues);
        setOwn(normalized, deviceId, merged);
    }
    return normalized;
}

/** The overrides in the array form the Homebridge UI round-trips. */
export function toMatterOverrideEntries(overrides: Record<string, MatterDeviceOverride>): MatterDeviceOverrideEntry[] {
    return Object.keys(overrides).map((deviceId: string): MatterDeviceOverrideEntry => ({ deviceId, ...overrides[deviceId] }));
}

/** Same contract as `normalizeMatterOverrides`, for recovery generations. */
export function normalizeMatterRecoveryRequests(
    configured: unknown,
    issues: ConfigIssues = new ConfigIssues(),
): Record<string, number> {
    const normalized: Record<string, number> = {};
    if (configured === undefined || configured === null) return normalized;
    for (const { where, row } of toRows(configured, 'matterRecoveryRequests', (deviceId, generation) => ({ deviceId, generation }), issues)) {
        if (!isPlainObject(row)) {
            issues.warn(where, `expected an object with deviceId and generation, received ${typeName(row)}; ignoring it`);
            continue;
        }
        const deviceId = rowDeviceId(row);
        if (!deviceId) continue;
        const generation = row.generation;
        if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
            issues.warn(where, `generation of ${cite(deviceId)} must be an integer of at least 1, received ${typeof generation === 'number' ? generation : typeName(generation)}; ignoring the row`);
            continue;
        }
        if (hasOwn(normalized, deviceId) && normalized[deviceId] !== generation) {
            issues.warn(where, `${cite(deviceId)} has more than one generation; the last one wins`);
        }
        setOwn(normalized, deviceId, generation);
    }
    return normalized;
}

/** The recovery generations in the array form the Homebridge UI round-trips. */
export function toMatterRecoveryEntries(requests: Record<string, number>): MatterRecoveryRequestEntry[] {
    return Object.keys(requests).map((deviceId: string): MatterRecoveryRequestEntry => ({ deviceId, generation: requests[deviceId] }));
}
