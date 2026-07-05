/**
 * Matter-only accessory name sanitisation.
 *
 * Normalises display names for Matter / Homebridge 2 controllers without
 * touching HAP names, UUIDs, or the original klares4 device names.
 *
 * The output is an *intersection* of three constraints:
 *
 *  - Matter spec §1.7.7.1 — nodeLabel/Basic.nodeLabel: UTF-8 string, max 32 chars.
 *  - HAP-NodeJS `checkName` rule (Apple HomeKit naming guidance):
 *      ^[\p{L}\p{N}][\p{L}\p{N}’ '.,-]*[\p{L}\p{N}’]$
 *  - Empirical Alexa/Google tolerance — both controllers happily accept the
 *    HomeKit-safe subset, so targeting HomeKit is also the safest target
 *    for the wider Matter ecosystem.
 *
 * The character allowlist lives in `src/display-name.ts` (shared with the HAP
 * naming path); this module owns the Matter-specific 32-char budget, the
 * collision suffix table and the collision-resolution registry.
 */

import { cleanDisplayName, truncateDisplayName } from '../display-name';

const MAX_NAME_LENGTH = 32;

/**
 * Sanitise a device name for use as a Matter accessory `displayName`.
 */
export function sanitizeMatterAccessoryName(name: string, fallback = 'Device'): string {
    const safe = clean(typeof name === 'string' ? name : '');
    if (safe) return safe;
    return clean(fallback) || 'Device';
}

function clean(raw: string): string {
    return cleanDisplayName(raw, MAX_NAME_LENGTH);
}

/**
 * Italian, HomeKit-safe collision suffix per Lares4 device type.
 * Abbreviations chosen so even the longest sanitised name (32 chars) + suffix
 * stays within the 32-char Matter limit when the head is itself reasonable.
 * For pathologically long names the head is truncated, never the suffix.
 */
const TYPE_SUFFIX: Record<string, string> = {
    zone: 'Sens.',
    sensor: 'Sens.',
    cover: 'Tapp.',
    light: 'Luce',
    thermostat: 'Term.',
    scenario: 'Scenario',
    gate: 'Cancello',
};

/**
 * Priority: higher = retains the clean name on collision.
 * User-controllable devices (cover, light, thermostat, gate, scenario)
 * outrank passive sensors (zone, sensor) — so a "Finestra Cucina" cover
 * keeps the clean label while the matching contact-sensor zone gets
 * "Finestra Cucina - Sens.".
 */
const TYPE_PRIORITY: Record<string, number> = {
    cover: 10,
    light: 10,
    thermostat: 10,
    gate: 10,
    scenario: 10,
    zone: 1,
    sensor: 1,
};

export function priorityOf(deviceType: string | undefined): number {
    if (!deviceType) return 0;
    return TYPE_PRIORITY[deviceType] ?? 0;
}

const SUFFIX_SEPARATOR = ' - ';

function nameAlreadyMentions(name: string, suffix: string): boolean {
    // Treat the suffix as a *root*: strip any trailing "." so "Tapp." → "Tapp",
    // and match it at any word boundary. This way "Tapparella Studio" is
    // recognised as already mentioning "Tapp.", and "Termostato Sala" as
    // already mentioning "Term.". Avoids redundant " - Tapp." / " - Term."
    // tags on names that already describe their own type.
    const root = suffix.replace(/\.$/, '');
    const pattern = new RegExp(`\\b${root}`, 'iu');
    return pattern.test(name);
}

export function buildTypedSuffix(name: string, deviceType: string | undefined): string | null {
    if (!deviceType) return null;
    const suffix = TYPE_SUFFIX[deviceType];
    if (!suffix) return null;
    if (nameAlreadyMentions(name, suffix)) return null;

    const tail = `${SUFFIX_SEPARATOR}${suffix}`;
    const maxNameLen = MAX_NAME_LENGTH - tail.length;
    if (maxNameLen <= 0) return null;
    const head = truncateDisplayName(name, maxNameLen);
    if (!head) return null;
    return `${head}${tail}`;
}

export function buildUuidFallbackSuffix(name: string, uuid: string, tagLength = 4): string {
    const tag = uuid.replace(/-/g, '').slice(-tagLength);
    const tail = `${SUFFIX_SEPARATOR}${tag}`;
    const maxNameLen = MAX_NAME_LENGTH - tail.length;
    if (maxNameLen <= 0) return truncateDisplayName(name, MAX_NAME_LENGTH);
    const head = truncateDisplayName(name, maxNameLen);
    return `${head}${tail}`;
}

interface SlotOwner {
    uuid: string;
    deviceType: string | undefined;
    sanitizedBase: string;
}

/**
 * Tracks sanitised names per registry instance.
 *
 * Collision policy:
 *
 *  1. Higher type priority always wins the clean name: a later-arriving
 *     device with *strictly higher type priority* displaces the incumbent,
 *     takes the clean name itself, and the displaced uuid is queued as a
 *     "pending rename" (see `consumePendingRenames`) so the caller can
 *     refresh that accessory's metadata.
 *  2. Same-priority collisions are resolved by a stable tiebreak on
 *     `device.id` (lexicographically smaller uuid keeps/gets the clean
 *     name), NOT by arrival order — arrival order depends on WS/array
 *     ordering and boot timing, which must never affect the final name a
 *     Matter/Alexa controller sees. The loser receives a typed suffix
 *     (` - Tapp.`, ` - Sens.`, ...); if the name already mentions its own
 *     type, fall back to a uuid-derived 4-char tag. This makes the same set
 *     of devices resolve to the same uuid -> displayName mapping regardless
 *     of the order they're discovered/re-mapped in.
 *
 * Since 2.1.4-rc.6 this incremental registry is the *fallback* path only:
 * the authoritative uuid → displayName mapping is the batch-computed,
 * persisted name-map (`matter-name-map.ts` / `matter-name-service.ts`).
 * The incremental path handles devices that are not in the persisted map
 * yet (first boot ever, devices newly added on the panel).
 */
export class MatterNameRegistry {
    private readonly slotOwners = new Map<string, SlotOwner>();
    private readonly uuidToName = new Map<string, string>();
    private readonly pendingRenames = new Map<string, string>();

    /**
     * Pre-assign a uuid → name mapping loaded from the persisted name-map.
     * Trusted input: no collision resolution is applied, the seeded slot is
     * simply marked as taken so later incremental `resolve` calls for *new*
     * devices see it and pick a suffix (or displace it by priority).
     */
    seed(uuid: string, finalName: string, sanitizedBase: string, deviceType?: string): void {
        this.slotOwners.set(finalName, { uuid, deviceType, sanitizedBase });
        this.uuidToName.set(uuid, finalName);
    }

    /** Current assigned display name for a uuid, if any (seeded or resolved). */
    currentNameOf(uuid: string): string | undefined {
        return this.uuidToName.get(uuid);
    }

    resolve(uuid: string, sanitized: string, deviceType?: string): string {
        const existingSlot = this.slotOwners.get(sanitized);

        // No collision (or same uuid revisiting): take the clean name.
        if (!existingSlot || existingSlot.uuid === uuid) {
            return this.assign(uuid, sanitized, sanitized, deviceType);
        }

        // Collision: strictly higher priority displaces the incumbent outright.
        // A same-priority tie is broken by a stable uuid comparison instead of
        // arrival order, so the outcome never depends on discovery/boot timing.
        const incomingPriority = priorityOf(deviceType);
        const existingPriority = priorityOf(existingSlot.deviceType);
        const displaces = incomingPriority > existingPriority
            || (incomingPriority === existingPriority && uuid < existingSlot.uuid);

        if (displaces) {
            const displacedName = this.suffixFor(existingSlot.uuid, existingSlot.sanitizedBase, existingSlot.deviceType);
            // Register the displaced uuid's new slot so a *third* colliding
            // device (same-priority tie, e.g. three identically-named sensors)
            // sees it as taken and doesn't independently pick the same suffix.
            this.slotOwners.set(displacedName, {
                uuid: existingSlot.uuid,
                deviceType: existingSlot.deviceType,
                sanitizedBase: existingSlot.sanitizedBase,
            });
            this.uuidToName.set(existingSlot.uuid, displacedName);
            this.pendingRenames.set(existingSlot.uuid, displacedName);
            return this.assign(uuid, sanitized, sanitized, deviceType);
        }

        // Otherwise: the incumbent keeps the slot; we pick a suffix for the newcomer.
        const candidate = this.suffixFor(uuid, sanitized, deviceType);
        return this.assign(uuid, sanitized, candidate, deviceType);
    }

    /**
     * Returns and clears the set of (uuid → newName) pairs that have been
     * displaced since the last call. Callers should refresh the matter
     * accessory metadata for each entry so the controller sees the new name.
     */
    consumePendingRenames(): Map<string, string> {
        const out = new Map(this.pendingRenames);
        this.pendingRenames.clear();
        return out;
    }

    private assign(uuid: string, sanitizedBase: string, finalName: string, deviceType: string | undefined): string {
        // Free the previous slot owned by this uuid, if any (re-mapping path).
        const previous = this.uuidToName.get(uuid);
        if (previous && previous !== finalName) {
            const owner = this.slotOwners.get(previous);
            if (owner && owner.uuid === uuid) this.slotOwners.delete(previous);
        }
        this.slotOwners.set(finalName, { uuid, deviceType, sanitizedBase });
        this.uuidToName.set(uuid, finalName);
        // If a pending rename was queued for this uuid and we're now resolving
        // again, the caller is about to consume the up-to-date name directly.
        this.pendingRenames.delete(uuid);
        return finalName;
    }

    private suffixFor(uuid: string, base: string, deviceType: string | undefined): string {
        const typed = buildTypedSuffix(base, deviceType);
        if (typed) {
            const existing = this.slotOwners.get(typed);
            if (!existing || existing.uuid === uuid) return typed;
        }
        return buildUuidFallbackSuffix(base, uuid);
    }
}
