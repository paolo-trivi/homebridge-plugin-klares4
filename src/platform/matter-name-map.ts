/**
 * Batch (two-phase) Matter name-map computation.
 *
 * `computeMatterNameMap` derives the final uuid → displayName mapping for a
 * *complete* device set in one pass, independent of discovery order:
 *
 *  1. Devices are sorted by (type priority desc, device.id asc) — the same
 *     rules the incremental `MatterNameRegistry` applies, but with the whole
 *     set known upfront there is nothing left to displace or rename later.
 *  2. Names are assigned first-come on the sorted list: clean sanitised name
 *     if free, typed suffix (` - Sens.`, ` - Tapp.`, ...) if taken, and a
 *     uuid-derived tag (progressively lengthened until unique) as last resort.
 *
 * Name slots are matched case-insensitively: voice assistants resolve
 * utterances case-insensitively, so "finestra studio" and "Finestra Studio"
 * are the same voice-namespace entry. By construction the resulting map can
 * never contain two equal (case-insensitive) display names.
 */

import type { Logger } from 'homebridge';
import {
    sanitizeMatterAccessoryName,
    buildTypedSuffix,
    buildUuidFallbackSuffix,
    priorityOf,
} from './matter-name-sanitizer';

export interface MatterNameMapEntry {
    uuid: string;
    /** Final Matter displayName (unique, HomeKit-safe, ≤32 chars). */
    name: string;
    /** Sanitised base name before any collision suffix. */
    base: string;
    type?: string;
    /**
     * Epoch ms of the last sync this uuid was actually discovered in. Absent
     * on entries written before this field existed; treated as "just seen" on
     * load so a first upgrade never expires anything.
     */
    lastSeen?: number;
    /**
     * True when the entry is a *reservation*: a uuid known from a previous
     * sync but absent from the current one. It holds its name slot so a
     * temporarily-missing device cannot have its name stolen while it is
     * away — see `computeMatterNameMap`.
     */
    reserved?: boolean;
}

export interface MatterNamedDevice {
    id: string;
    name: string;
    type?: string;
}

export interface DuplicateNameGroup {
    name: string;
    uuids: string[];
}

function compareDevices(a: MatterNamedDevice, b: MatterNamedDevice): number {
    const byPriority = priorityOf(b.type) - priorityOf(a.type);
    if (byPriority !== 0) return byPriority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function uniqueUuidFallback(base: string, uuid: string, taken: Set<string>): string {
    for (let tagLength = 4; tagLength <= 12; tagLength++) {
        const candidate = buildUuidFallbackSuffix(base, uuid, tagLength);
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    // Theoretical last resort (uuid tags exhausted): disambiguate numerically.
    for (let n = 2; ; n++) {
        const candidate = buildUuidFallbackSuffix(`${base} ${n}`, uuid);
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
}

/**
 * Compute the deterministic uuid → displayName map for the given device set.
 * Pure function: same set in, same map out — regardless of iteration order.
 *
 * `reservations` are entries from the persisted map whose device did not show
 * up in this sync. They take part in the computation as ordinary devices
 * (using their stored base name and type) instead of being dropped, so a
 * device that is briefly missing — a partial WS sync, a prune that removed it
 * — cannot have its clean name taken over by a lower-priority namesake while
 * it is away. Priority still decides: a live `cover` outranks a reserved
 * `zone` and takes the clean name, exactly as if both were present.
 *
 * Reserved entries come back in the result flagged `reserved: true` so the
 * caller can persist them without trying to re-register an absent endpoint.
 */
export function computeMatterNameMap(
    devices: Iterable<MatterNamedDevice>,
    reservations: Iterable<MatterNameMapEntry> = [],
): Map<string, MatterNameMapEntry> {
    const byId = new Map<string, MatterNamedDevice>();
    for (const device of devices) {
        if (device && typeof device.id === 'string' && device.id) byId.set(device.id, device);
    }

    const reservedById = new Map<string, MatterNameMapEntry>();
    for (const entry of reservations) {
        // A live device always resolves from its own current panel name; a
        // reservation for it would be stale, so live wins.
        if (!entry || !entry.uuid || byId.has(entry.uuid)) continue;
        reservedById.set(entry.uuid, entry);
    }

    const candidates: MatterNamedDevice[] = [...byId.values()];
    for (const entry of reservedById.values()) {
        candidates.push({ id: entry.uuid, name: entry.base, type: entry.type });
    }
    const sorted = candidates.sort(compareDevices);

    const taken = new Set<string>();
    const out = new Map<string, MatterNameMapEntry>();
    for (const device of sorted) {
        const base = sanitizeMatterAccessoryName(device.name, device.id);
        let candidate: string | null = taken.has(base.toLowerCase()) ? null : base;
        if (!candidate) {
            const typed = buildTypedSuffix(base, device.type);
            if (typed && !taken.has(typed.toLowerCase())) candidate = typed;
        }
        if (!candidate) candidate = uniqueUuidFallback(base, device.id, taken);
        taken.add(candidate.toLowerCase());

        const reservation = reservedById.get(device.id);
        out.set(device.id, {
            uuid: device.id,
            name: candidate,
            base,
            type: device.type,
            ...(reservation
                ? { lastSeen: reservation.lastSeen, reserved: true }
                : { lastSeen: Date.now() }),
        });
    }
    return out;
}

/**
 * Voice-namespace guard: groups of entries sharing the same display name
 * case-insensitively. Empty by construction of `computeMatterNameMap`; a
 * non-empty result is a name-map bug and must be surfaced loudly.
 */
export function findDuplicateDisplayNames(entries: Iterable<MatterNameMapEntry>): DuplicateNameGroup[] {
    const groups = new Map<string, { name: string; uuids: string[] }>();
    for (const entry of entries) {
        const key = entry.name.toLowerCase();
        const group = groups.get(key);
        if (group) group.uuids.push(entry.uuid);
        else groups.set(key, { name: entry.name, uuids: [entry.uuid] });
    }
    return [...groups.values()].filter((g) => g.uuids.length > 1);
}

/**
 * End-of-sync summary: the final name → uuid table plus an explicit WARN for
 * any (case-insensitive) duplicate pair left after suffixing — which should
 * never happen; if it does, it's a name-map bug worth reporting.
 */
export function logNameTable(
    log: Logger,
    entries: Iterable<MatterNameMapEntry>,
    duplicates: DuplicateNameGroup[],
): void {
    const rows = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const live = rows.filter((r) => !r.reserved).length;
    const reserved = rows.length - live;
    log.info(`[Matter] final name-map (${live} devices${reserved ? `, ${reserved} reserved slots` : ''}):`);
    for (const row of rows) {
        log.info(
            `   "${row.name}" -> ${row.uuid}${row.type ? ` [${row.type}]` : ''}`
            + `${row.reserved ? ' (reserved — not discovered in this sync)' : ''}`,
        );
    }
    for (const dup of duplicates) {
        log.warn(
            `[Matter] DUPLICATE display name "${dup.name}" shared by ${dup.uuids.join(', ')} — `
            + 'voice commands will be ambiguous. This is a name-map bug, please report it.',
        );
    }
}
