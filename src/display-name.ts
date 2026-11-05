/**
 * Shared display-name cleaning core (domain layer, no dependencies).
 *
 * Single source of truth for the character allowlist used by both naming
 * paths:
 *
 *  - HAP accessories (`sanitizeHapDisplayName`, 64-char budget) — keeps the
 *    `Name` characteristic within the HAP-NodeJS `checkName` rule so cached
 *    and freshly-discovered accessories stop triggering the boot-time
 *    "invalid 'Name' characteristic" warning.
 *  - Matter accessories (`platform/matter-name-sanitizer.ts`, 32-char budget
 *    per Matter spec §1.7.7.1 nodeLabel) — reuses `cleanDisplayName` so both
 *    ecosystems always derive the *same* words from the same Lares4 label.
 *
 * HAP-NodeJS `checkName` rule (Apple HomeKit naming guidance):
 *     ^[\p{L}\p{N}][\p{L}\p{N}’ '.,-]*[\p{L}\p{N}’]$
 * HAP-NodeJS 2.2.2 tightened the end of that rule to a letter or digit only
 * (no trailing ’) and, since first and last character are distinct, a name
 * needs at least two characters. Those two extra rules are applied by
 * `sanitizeHapDisplayName` alone: `cleanDisplayName` keeps its historical
 * output because paired Matter endpoints and the persisted Matter name map
 * are derived from it.
 *
 * Allowlist:
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

const ALLOWED_MID_CHARS = /[^\p{L}\p{N}’ '.,-]/gu;

// Per HomeKit rule the name MUST start with letter/digit and end with letter/digit/’.
const BOUNDARY_LEFT = /^[^\p{L}\p{N}]+/u;
const BOUNDARY_RIGHT = /[^\p{L}\p{N}’]+$/u;

/** Maximum HAP accessory name length (HomeKit allows up to 64 characters). */
export const HAP_MAX_NAME_LENGTH = 64;

/**
 * Truncate to `maxLength` making sure the result still ends with a valid
 * boundary character (letter/digit/’). Used for suffix head-truncation too.
 */
export function truncateDisplayName(name: string, maxLength: number): string {
    const characters = Array.from(name);
    if (characters.length <= maxLength) return name;
    return characters.slice(0, maxLength).join('').replace(BOUNDARY_RIGHT, '');
}

/**
 * Core cleaning pass shared by the HAP and Matter sanitisers.
 * Returns '' when nothing usable survives (callers apply their fallback).
 */
export function cleanDisplayName(raw: string, maxLength: number): string {
    let s = raw.normalize('NFKC');
    s = s.replace(/\+/g, ' e ');
    s = s.replace(/[()[\]]/g, ' ');
    s = s.replace(ALLOWED_MID_CHARS, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(BOUNDARY_LEFT, '').replace(BOUNDARY_RIGHT, '');
    return truncateDisplayName(s, maxLength);
}

// HAP-only: HAP-NodeJS 2.2.2 requires the last character to be a letter/digit.
const HAP_BOUNDARY_RIGHT = /[^\p{L}\p{N}]+$/u;

function cleanHapName(raw: string): string {
    return cleanDisplayName(raw, HAP_MAX_NAME_LENGTH).replace(HAP_BOUNDARY_RIGHT, '');
}

function isHapNameLongEnough(name: string): boolean {
    return Array.from(name).length >= 2;
}

/**
 * Sanitise a device name for the HAP path (PlatformAccessory displayName and
 * the `Name` characteristic set by the accessory handlers). Guaranteed to
 * satisfy the HAP-NodeJS 2.2.2 `checkName` regex; never returns an empty
 * string. A one-character name is completed with the fallback (the device
 * id), e.g. "A" -> "A zone 3".
 */
export function sanitizeHapDisplayName(name: string, fallback = 'Device'): string {
    const raw = typeof name === 'string' ? name : '';
    const safe = cleanHapName(raw);
    if (isHapNameLongEnough(safe)) return safe;
    if (safe) {
        const completed = cleanHapName(`${safe} ${fallback}`);
        if (isHapNameLongEnough(completed)) return completed;
    }
    const safeFallback = cleanHapName(fallback);
    return isHapNameLongEnough(safeFallback) ? safeFallback : 'Device';
}
