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
    if (name.length <= maxLength) return name;
    return name.slice(0, maxLength).replace(BOUNDARY_RIGHT, '');
}

/**
 * Core cleaning pass shared by the HAP and Matter sanitisers.
 * Returns '' when nothing usable survives (callers apply their fallback).
 */
export function cleanDisplayName(raw: string, maxLength: number): string {
    let s = raw;
    s = s.replace(/\+/g, ' e ');
    s = s.replace(/[()[\]]/g, ' ');
    s = s.replace(ALLOWED_MID_CHARS, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(BOUNDARY_LEFT, '').replace(BOUNDARY_RIGHT, '');
    return truncateDisplayName(s, maxLength);
}

/**
 * Sanitise a device name for the HAP path (PlatformAccessory displayName and
 * the `Name` characteristic set by the accessory handlers). Guaranteed to
 * satisfy the HAP-NodeJS `checkName` regex; never returns an empty string.
 */
export function sanitizeHapDisplayName(name: string, fallback = 'Device'): string {
    const safe = cleanDisplayName(typeof name === 'string' ? name : '', HAP_MAX_NAME_LENGTH);
    if (safe) return safe;
    return cleanDisplayName(fallback, HAP_MAX_NAME_LENGTH) || 'Device';
}
