/**
 * The prune discipline shared by HAP (`accessory-registry.ts`) and Matter
 * (`matter-prune-tracker.ts`).
 *
 * Removing an accessory is irreversible for the user (rooms, scenes and
 * automations are lost), while a discovery sync can be partial: the panel may
 * answer a discovery READ with `RESULT: FAIL` or not answer it at all, and the
 * sync still completes. Every login is a sync of its own (`sync-lifecycle.ts`)
 * and each sync is judged on its own:
 *
 *  1. Discovery floor: a sync that saw fewer than half of the known
 *     accessories is a failed sync; nobody counts as missing.
 *  2. Family guard: an accessory counts as missing only if its discovery
 *     family (`zone_`, `light_`, `sensor_temp_`, ...) listed at least one
 *     device in this sync. A family with no device at all did not answer.
 *  3. Consecutive misses: a missing accessory is removed after
 *     `PRUNE_STALE_THRESHOLD_CYCLES` consecutive syncs. The counter is
 *     persisted, so it survives restarts.
 *
 * Accessories hidden by the config or by the scenario policy do not depend on
 * what the panel reported: they follow their own path (HAP removes them at
 * once, Matter after the same consecutive-sync counter).
 */
export const PRUNE_STALE_THRESHOLD_CYCLES = 3;

export const PRUNE_MIN_DISCOVERY_RATIO = 0.5;

/** Prefix of the panel's own temperature probes (`STATUS_SYSTEM`). */
const SYSTEM_PROBE_PREFIX = 'sensor_system_';

/**
 * Discovery family of a device id: the id without its trailing item id
 * ("zone_12" -> "zone_", "sensor_temp_3" -> "sensor_temp_").
 *
 * The panel's own probes are a family each ("sensor_system_temp_out"): the
 * panel reports `NA` for a probe that has no reading and the plugin then
 * reports no device, so the other probe answering proves nothing about it.
 * Such a probe is never missing; it goes away only through an exclusion.
 */
export function discoveryFamily(deviceId: string): string {
    if (deviceId.startsWith(SYSTEM_PROBE_PREFIX)) return deviceId;
    return deviceId.replace(/[^_]*$/, '');
}

/** Families with at least one of these device ids. */
export function familiesOf(deviceIds: Iterable<string>): Set<string> {
    const families = new Set<string>();
    for (const id of deviceIds) families.add(discoveryFamily(id));
    return families;
}

/** True when a sync that saw `discovered` of `known` accessories is too partial to judge absences. */
export function belowDiscoveryFloor(discovered: number, known: number): boolean {
    return known > 0 && discovered < known * PRUNE_MIN_DISCOVERY_RATIO;
}

/** What the end of a sync tells the prunes. */
export interface SyncOutcome {
    /** Families that listed at least one device in this sync. */
    answeredFamilies: ReadonlySet<string>;
}
