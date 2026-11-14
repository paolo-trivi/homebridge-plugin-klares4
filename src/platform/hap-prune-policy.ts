import type { PlatformAccessory } from 'homebridge';
import type { KseniaDevice } from '../types';

/**
 * HAP counterpart of the Matter prune discipline (`matter-prune-tracker.ts`).
 *
 * Removing a HAP accessory is irreversible for the user (rooms, scenes and
 * automations are lost), while a discovery sync can be partial: the panel may
 * answer a discovery READ with `RESULT: FAIL` or not answer it at all, and the
 * sync still completes on the first REALTIME response. Two guards apply:
 *
 *  1. Category guard: an accessory is a removal candidate only if its
 *     discovery family (`zone_`, `light_`, `sensor_temp_`, ...) produced at
 *     least one device in this sync. A family with no device at all is
 *     treated as "not answered" and left alone.
 *  2. Consecutive misses: a candidate is removed only after being absent for
 *     `HAP_PRUNE_STALE_THRESHOLD_CYCLES` consecutive syncs. The counter lives
 *     in the accessory context, which Homebridge persists with the cached
 *     accessory, so it survives restarts.
 */
export const HAP_PRUNE_STALE_THRESHOLD_CYCLES = 3;

/** Accessory-context key holding the consecutive missed-sync counter. */
export const MISSED_CYCLES_CONTEXT_KEY = 'missedDiscoveryCycles';

/**
 * Discovery family of a device id: the id without its trailing item id
 * ("zone_12" -> "zone_", "sensor_temp_3" -> "sensor_temp_",
 * "sensor_system_temp_in" -> "sensor_system_temp_").
 */
export function discoveryFamily(deviceId: string): string {
    return deviceId.replace(/[^_]*$/, '');
}

export function cachedDevice(accessory: PlatformAccessory): KseniaDevice | undefined {
    const device = accessory.context?.device as KseniaDevice | undefined;
    return device && typeof device.id === 'string' && device.id ? device : undefined;
}

export function readMissedCycles(accessory: PlatformAccessory): number {
    const value: unknown = accessory.context?.[MISSED_CYCLES_CONTEXT_KEY];
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** Returns whether the stored counter changed. */
export function writeMissedCycles(accessory: PlatformAccessory, value: number): boolean {
    if (readMissedCycles(accessory) === value) return false;
    if (value > 0) {
        accessory.context[MISSED_CYCLES_CONTEXT_KEY] = value;
    } else {
        delete accessory.context[MISSED_CYCLES_CONTEXT_KEY];
    }
    return true;
}
