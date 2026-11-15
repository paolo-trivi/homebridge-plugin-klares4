import type { KseniaDevice } from '../types';
import { markStatusPlaceholder, mergeKnownState } from '../device-observation';

/** IDs adopted since the discovery round of a device map was opened. */
const openRounds = new WeakMap<Map<string, KseniaDevice>, Set<string>>();

/**
 * Stores a device parsed from a discovery READ_RES. Every login re-reads the
 * configuration, so on a reconnect the device is already known: it keeps the
 * observed state and takes the new configuration. A device seen for the first
 * time carries parser placeholders and is flagged as not yet observed.
 */
export function adoptDiscoveredDevice<T extends KseniaDevice>(devices: Map<string, KseniaDevice>, fresh: T): T {
    const device = mergeKnownState(fresh, devices.get(fresh.id));
    if (device === fresh) markStatusPlaceholder(device);
    devices.set(device.id, device);
    openRounds.get(devices)?.add(device.id);
    return device;
}

/** Starts recording the devices one section of a discovery read adopts. */
export function openDiscoveryRound(devices: Map<string, KseniaDevice>): void {
    openRounds.set(devices, new Set());
}

/** Stops recording without removing anything (the read was not complete). */
export function abandonDiscoveryRound(devices: Map<string, KseniaDevice>): void {
    openRounds.delete(devices);
}

/**
 * Closes the round of a complete discovery section: every device of that
 * family (`belongsToFamily`) that the section did not list is removed, so a
 * device deleted or re-categorised on the panel stops receiving status
 * updates under its old ID. Returns the removed IDs.
 */
export function closeDiscoveryRound(
    devices: Map<string, KseniaDevice>,
    belongsToFamily: (id: string) => boolean,
): string[] {
    const listed = openRounds.get(devices);
    openRounds.delete(devices);
    if (!listed) return [];
    const removed: string[] = [];
    for (const id of devices.keys()) {
        if (belongsToFamily(id) && !listed.has(id)) removed.push(id);
    }
    for (const id of removed) devices.delete(id);
    return removed;
}
