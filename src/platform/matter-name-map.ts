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
 */
export function computeMatterNameMap(devices: Iterable<MatterNamedDevice>): Map<string, MatterNameMapEntry> {
    const byId = new Map<string, MatterNamedDevice>();
    for (const device of devices) {
        if (device && typeof device.id === 'string' && device.id) byId.set(device.id, device);
    }
    const sorted = [...byId.values()].sort(compareDevices);

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
        out.set(device.id, { uuid: device.id, name: candidate, base, type: device.type });
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
    log.info(`[Matter] final name-map (${rows.length} devices):`);
    for (const row of rows) {
        log.info(`   "${row.name}" -> ${row.uuid}${row.type ? ` [${row.type}]` : ''}`);
    }
    for (const dup of duplicates) {
        log.warn(
            `[Matter] DUPLICATE display name "${dup.name}" shared by ${dup.uuids.join(', ')} — `
            + 'voice commands will be ambiguous. This is a name-map bug, please report it.',
        );
    }
}
