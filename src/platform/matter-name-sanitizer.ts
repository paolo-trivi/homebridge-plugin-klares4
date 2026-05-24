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
 * Allowlist (single source of truth, kept in sync with HAP `checkName`):
 *   \p{L}   Unicode letters (includes Italian accents à è é ì ò ù)
 *   \p{N}   Unicode digits
 *   space
 *   '       ASCII apostrophe
 *   ’  Right single quotation mark (typographic apostrophe)
 *   .       period
 *   ,       comma
 *   -       hyphen-minus
 *
 * Anything outside this set is replaced with a single space (then collapsed).
 */

const MAX_NAME_LENGTH = 32;

const ALLOWED_MID_CHARS = /[^\p{L}\p{N}’ '.,-]/gu;

// Per HomeKit rule the name MUST start with letter/digit and end with letter/digit/’.
const BOUNDARY_LEFT = /^[^\p{L}\p{N}]+/u;
const BOUNDARY_RIGHT = /[^\p{L}\p{N}’]+$/u;

/**
 * Sanitise a device name for use as a Matter accessory `displayName`.
 */
export function sanitizeMatterAccessoryName(name: string, fallback = 'Device'): string {
    const safe = clean(typeof name === 'string' ? name : '');
    if (safe) return safe;
    return clean(fallback) || 'Device';
}

function clean(raw: string): string {
    let s = raw;
    s = s.replace(/\+/g, ' e ');
    s = s.replace(/[()[\]]/g, ' ');
    s = s.replace(ALLOWED_MID_CHARS, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(BOUNDARY_LEFT, '').replace(BOUNDARY_RIGHT, '');
    if (s.length > MAX_NAME_LENGTH) {
        s = s.slice(0, MAX_NAME_LENGTH).replace(BOUNDARY_RIGHT, '');
    }
    return s;
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

function priorityOf(deviceType: string | undefined): number {
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

function buildTypedSuffix(name: string, deviceType: string | undefined): string | null {
    if (!deviceType) return null;
    const suffix = TYPE_SUFFIX[deviceType];
    if (!suffix) return null;
    if (nameAlreadyMentions(name, suffix)) return null;

    const tail = `${SUFFIX_SEPARATOR}${suffix}`;
    const maxNameLen = MAX_NAME_LENGTH - tail.length;
    if (maxNameLen <= 0) return null;
    const head = name.length <= maxNameLen ? name : name.slice(0, maxNameLen).replace(BOUNDARY_RIGHT, '');
    if (!head) return null;
    return `${head}${tail}`;
}

function buildUuidFallbackSuffix(name: string, uuid: string): string {
    const tag = uuid.replace(/-/g, '').slice(-4);
    const tail = `${SUFFIX_SEPARATOR}${tag}`;
    const maxNameLen = MAX_NAME_LENGTH - tail.length;
    if (maxNameLen <= 0) return name.slice(0, MAX_NAME_LENGTH).replace(BOUNDARY_RIGHT, '');
    const head = name.length <= maxNameLen ? name : name.slice(0, maxNameLen).replace(BOUNDARY_RIGHT, '');
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
 *  1. First arrival wins by default.
 *  2. EXCEPT when a later device has *strictly higher type priority*: it
 *     displaces the incumbent, takes the clean name itself, and the displaced
 *     uuid is queued as a "pending rename" (see `consumePendingRenames`) so
 *     the caller can refresh that accessory's metadata.
 *  3. Same-priority collisions: incumbent keeps the clean name, newcomer
 *     receives a typed suffix (` - Tapp.`, ` - Sens.`, ...). If the name
 *     already mentions its own type, fall back to a uuid-derived 4-char tag.
 */
export class MatterNameRegistry {
    private readonly slotOwners = new Map<string, SlotOwner>();
    private readonly uuidToName = new Map<string, string>();
    private readonly pendingRenames = new Map<string, string>();

    resolve(uuid: string, sanitized: string, deviceType?: string): string {
        const existingSlot = this.slotOwners.get(sanitized);

        // No collision (or same uuid revisiting): take the clean name.
        if (!existingSlot || existingSlot.uuid === uuid) {
            return this.assign(uuid, sanitized, sanitized, deviceType);
        }

        // Collision with strictly higher priority → displace the incumbent.
        if (priorityOf(deviceType) > priorityOf(existingSlot.deviceType)) {
            const displacedName = this.suffixFor(existingSlot.uuid, existingSlot.sanitizedBase, existingSlot.deviceType);
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
