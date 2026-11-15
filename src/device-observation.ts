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

/**
 * "The panel reported this value" must survive a restart together with the
 * value. Homebridge persists the accessory `context` (the device snapshot and
 * whatever else is stored next to it) in its HAP and Matter caches, so the marker
 * lives there, not in the status (which every consumer compares and serializes).
 * It is versioned: a cache written before it existed (2.2.0 and earlier) has none.
 */
const REPORTED_KEY = 'panelReported';
const REPORTED_VERSION = 1;

/** Types whose discovery placeholder (0 °C, 50 %, position 0) looks like a measurement. */
const TYPES_WITH_PLACEHOLDERS: ReadonlySet<string> = new Set(['sensor', 'cover']);

type AccessoryContext = Record<string, unknown>;

export function markStatusPlaceholder(device: KseniaDevice): void {
    placeholderStatuses.add(device.status);
}

export function markStatusObserved(device: KseniaDevice): void {
    placeholderStatuses.delete(device.status);
}

/**
 * Keeps the persisted marker in step with the device stored in `context`: set
 * when the state was reported by the panel, absent otherwise. Written only for
 * the types that have placeholders.
 */
export function recordObservation(context: AccessoryContext, device: KseniaDevice): void {
    if (!TYPES_WITH_PLACEHOLDERS.has(device.type)) return;
    if (hasObservedState(device)) context[REPORTED_KEY] = REPORTED_VERSION;
    else delete context[REPORTED_KEY];
}

/** `context` for a new accessory holding `device`, with the observation marker when it applies. */
export function contextWithObservation(device: KseniaDevice): AccessoryContext {
    const context: AccessoryContext = { device };
    recordObservation(context, device);
    return context;
}

/**
 * A device restored from a Homebridge cache (HAP or Matter). For the types whose
 * placeholder is indistinguishable from a reading, a state without the marker was
 * never reported by the panel (or was saved by a version that did not record it):
 * it is not a reading. Types without such placeholders keep their cached state.
 */
export function adoptCachedState(context: AccessoryContext, device: KseniaDevice): void {
    if (typeof device.status !== 'object' || device.status === null || !TYPES_WITH_PLACEHOLDERS.has(device.type)) return;
    if (context[REPORTED_KEY] !== REPORTED_VERSION) markStatusPlaceholder(device);
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
