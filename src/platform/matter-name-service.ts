import type { Logger } from 'homebridge';
import { MatterNameRegistry, sanitizeMatterAccessoryName } from './matter-name-sanitizer';
import {
    computeMatterNameMap,
    findDuplicateDisplayNames,
    type DuplicateNameGroup,
    type MatterNameMapEntry,
    type MatterNamedDevice,
} from './matter-name-map';
import { MatterNameStore } from './matter-name-store';

export interface NameMapFinalizeResult {
    /** Authoritative uuid → entry map for the finalized device set. */
    entries: Map<string, MatterNameMapEntry>;
    /** Case-insensitive duplicate names (must be empty; guard for bugs). */
    duplicates: DuplicateNameGroup[];
    /** True when the on-disk map actually changed (panel-side changes). */
    persisted: boolean;
}

/**
 * Two-phase Matter naming:
 *
 *  - Phase 1 (per-device, during discovery): `resolveName` answers from the
 *    persisted name-map loaded at construction, so from the second boot on
 *    every device registers with its final collision-resolved name from the
 *    very first `registerPlatformAccessories` call. Devices not in the map
 *    yet (first boot ever, devices newly added on the panel) fall back to
 *    the incremental `MatterNameRegistry` resolution, which sees the seeded
 *    slots and therefore can never hand out a name the map already owns.
 *
 *  - Phase 2 (batch, at initial-sync-complete): `finalize` recomputes the
 *    whole map from the complete device set, replaces the live registry and
 *    persists the result. The caller diffs the outcome against what was
 *    actually registered and refreshes only the accessories whose name
 *    changed (rare: panel-side additions/renames).
 */
export class MatterNameService {
    private registry = new MatterNameRegistry();
    private readonly store: MatterNameStore;

    constructor(storagePath: string, log: Logger) {
        this.store = new MatterNameStore(storagePath, log);
        for (const entry of this.store.load()) {
            this.registry.seed(entry.uuid, entry.name, entry.base, entry.type);
        }
    }

    /**
     * Display name for a device at mapping time. Stable for known uuids —
     * repeated calls (metadata re-mapping, state refreshes) never re-resolve
     * and therefore never churn.
     */
    resolveName(device: MatterNamedDevice): string {
        const known = this.registry.currentNameOf(device.id);
        if (known) return known;
        return this.registry.resolve(device.id, sanitizeMatterAccessoryName(device.name, device.id), device.type);
    }

    /** Current assigned name without side effects (undefined if unknown). */
    currentNameOf(uuid: string): string | undefined {
        return this.registry.currentNameOf(uuid);
    }

    /**
     * Batch-recompute the map from the complete device set, replace the live
     * registry state and persist to disk when changed.
     */
    finalize(devices: Iterable<MatterNamedDevice>): NameMapFinalizeResult {
        const entries = computeMatterNameMap(devices);
        const duplicates = findDuplicateDisplayNames(entries.values());

        // Drop any pending displaced-rename left by the incremental fallback:
        // the batch map supersedes it (the caller refreshes from the map diff).
        this.registry.consumePendingRenames();
        const fresh = new MatterNameRegistry();
        for (const entry of entries.values()) {
            fresh.seed(entry.uuid, entry.name, entry.base, entry.type);
        }
        this.registry = fresh;

        const persisted = this.store.save([...entries.values()]);
        return { entries, duplicates, persisted };
    }
}
