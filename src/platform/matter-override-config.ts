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

/**
 * Accepts either form and always yields a map keyed by device ID. Entries
 * without a usable device ID are dropped rather than throwing: a malformed
 * row in the UI must not stop the platform from starting.
 */
export function normalizeMatterOverrides(
    configured: MatterOverridesConfig | undefined,
): Record<string, MatterDeviceOverride> {
    if (!configured) return {};
    if (!Array.isArray(configured)) return configured;

    const normalized: Record<string, MatterDeviceOverride> = {};
    for (const entry of configured) {
        if (!entry || !isNonEmptyString(entry.deviceId)) continue;
        const override: MatterDeviceOverride = {};
        if (isNonEmptyString(entry.name)) override.name = entry.name.trim();
        if (typeof entry.exposed === 'boolean') override.exposed = entry.exposed;
        if (override.name === undefined && override.exposed === undefined) continue;
        normalized[entry.deviceId.trim()] = override;
    }
    return normalized;
}

/** Same contract as `normalizeMatterOverrides`, for recovery generations. */
export function normalizeMatterRecoveryRequests(
    configured: MatterRecoveryRequestsConfig | undefined,
): Record<string, number> {
    if (!configured) return {};
    if (!Array.isArray(configured)) return configured;

    const normalized: Record<string, number> = {};
    for (const entry of configured) {
        if (!entry || !isNonEmptyString(entry.deviceId)) continue;
        const generation = entry.generation;
        if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) continue;
        normalized[entry.deviceId.trim()] = generation;
    }
    return normalized;
}
