import type { KseniaDevice, KseniaThermostat } from './types';
import { syncThermostatTopLevelFromStatus } from './thermostat-state';

/**
 * Discovery (READ_RES ZONES / MULTI_TYPES) carries configuration only: the
 * parsers fill `status` with placeholders (off, closed, 0 °C, thermostat off)
 * until STATUS_* or REALTIME report the real state. Those placeholders must
 * not reach HomeKit or Matter as if they were observed, or every boot and
 * every reconnect produces spurious transitions that can fire automations.
 *
 * Keyed on the status object: consumers shallow-copy devices (custom and
 * Matter names) but share `status`, and the status updaters mutate it in place.
 */
const placeholderStatuses = new WeakSet<object>();

export function markStatusPlaceholder(device: KseniaDevice): void {
    placeholderStatuses.add(device.status);
}

export function markStatusObserved(device: KseniaDevice): void {
    placeholderStatuses.delete(device.status);
}

export function hasObservedState(device: KseniaDevice): boolean {
    return !placeholderStatuses.has(device.status);
}

/**
 * A device re-read from the panel keeps the state already known for it (from
 * this connection, or from the Homebridge cache at boot) and takes only the
 * configuration (name, description, ...) from the new read.
 */
export function mergeKnownState<T extends KseniaDevice>(fresh: T, known: KseniaDevice | undefined): T {
    if (!known || known.type !== fresh.type || !known.status) return fresh;
    const merged = { ...known, ...fresh, status: known.status } as T;
    if (merged.type === 'thermostat') syncThermostatTopLevelFromStatus(merged as KseniaThermostat);
    return merged;
}
