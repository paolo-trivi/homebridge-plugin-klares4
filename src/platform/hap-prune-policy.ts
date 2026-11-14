import type { PlatformAccessory } from 'homebridge';
import type { KseniaDevice } from '../types';
import { PRUNE_STALE_THRESHOLD_CYCLES } from './prune-policy';

export { discoveryFamily } from './prune-policy';

/**
 * HAP side of the prune discipline (`prune-policy.ts`). The missed-sync
 * counter lives in the accessory context, which Homebridge persists with the
 * cached accessory, so it survives restarts.
 */
export const HAP_PRUNE_STALE_THRESHOLD_CYCLES = PRUNE_STALE_THRESHOLD_CYCLES;

/** Accessory-context key holding the consecutive missed-sync counter. */
export const MISSED_CYCLES_CONTEXT_KEY = 'missedDiscoveryCycles';

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
