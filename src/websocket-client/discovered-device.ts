import type { KseniaDevice } from '../types';
import { markStatusPlaceholder, mergeKnownState } from '../device-observation';

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
    return device;
}
