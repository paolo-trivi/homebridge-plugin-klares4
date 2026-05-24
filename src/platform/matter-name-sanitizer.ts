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
 *
 * Pipeline:
 *  1. Replace `+` with ` e ` (human-readable expansion of "Inserisci A+B").
 *  2. Strip parentheses/brackets but keep their content.
 *  3. Replace every char outside the allowlist with a space.
 *  4. Collapse whitespace, trim.
 *  5. Trim non-allowed boundary chars (so first/last char satisfies HAP rule).
 *  6. Truncate to MAX_NAME_LENGTH, retrim boundary on the right.
 *  7. Empty result → `fallback` (default 'Device'), itself run through the
 *     same boundary trim to guarantee HomeKit compliance.
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
 * Every value uses only characters from the allowlist above.
 */
const TYPE_SUFFIX: Record<string, string> = {
    zone: 'Sensore',
    sensor: 'Sensore',
    cover: 'Tapparella',
    light: 'Luce',
    thermostat: 'Termostato',
    scenario: 'Scenario',
    gate: 'Cancello',
};

const SUFFIX_SEPARATOR = ' - ';

/**
 * Does `name` already mention `suffix` as a whole word?
 * Used to skip redundant collision tags like "Tapparella Studio - Tapparella".
 */
function nameAlreadyMentions(name: string, suffix: string): boolean {
    const pattern = new RegExp(`(^|\\s)${suffix}(\\s|$)`, 'iu');
    return pattern.test(name);
}

/**
 * Build a typed-suffix candidate, honouring the 32-char cap by truncating the
 * *name* part, never the suffix. Returns the candidate or `null` if the type
 * suffix is unknown or the original name already mentions the type.
 */
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

/**
 * Last-resort suffix when the typed suffix is unavailable or also collides.
 * Uses the last 4 hex-like chars of the uuid — same shape as before for
 * backward compatibility with installations that may already display this.
 */
function buildUuidFallbackSuffix(name: string, uuid: string): string {
    const tag = uuid.replace(/-/g, '').slice(-4);
    const tail = `${SUFFIX_SEPARATOR}${tag}`;
    const maxNameLen = MAX_NAME_LENGTH - tail.length;
    if (maxNameLen <= 0) return name.slice(0, MAX_NAME_LENGTH).replace(BOUNDARY_RIGHT, '');
    const head = name.length <= maxNameLen ? name : name.slice(0, maxNameLen).replace(BOUNDARY_RIGHT, '');
    return `${head}${tail}`;
}

/**
 * Tracks sanitised names per registry instance so that two devices whose
 * names normalise to the same string receive distinct, human-readable suffixes
 * based on their Lares4 device type.
 */
export class MatterNameRegistry {
    private readonly nameToUuid = new Map<string, string>();

    /**
     * Return `sanitized` if it has not been used yet (or was used by the same
     * uuid). Otherwise append a typed suffix (' - Sensore', ' - Tapparella',
     * ...). If the typed suffix is unavailable or already taken, fall back to
     * the legacy uuid-derived 4-char suffix.
     *
     * `deviceType` is the Lares4 device.type (zone, cover, light, ...). It is
     * optional for backward compatibility with callers that pre-date the typed
     * suffix; in that case the uuid fallback is used immediately on collision.
     */
    resolve(uuid: string, sanitized: string, deviceType?: string): string {
        const existing = this.nameToUuid.get(sanitized);
        if (!existing || existing === uuid) {
            this.nameToUuid.set(sanitized, uuid);
            return sanitized;
        }

        const typed = buildTypedSuffix(sanitized, deviceType);
        if (typed) {
            const typedExisting = this.nameToUuid.get(typed);
            if (!typedExisting || typedExisting === uuid) {
                this.nameToUuid.set(typed, uuid);
                return typed;
            }
        }

        const fallback = buildUuidFallbackSuffix(sanitized, uuid);
        this.nameToUuid.set(fallback, uuid);
        return fallback;
    }
}
