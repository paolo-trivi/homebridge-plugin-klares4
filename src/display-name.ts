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
 *  - Matter accessories (`platform/matter-name-sanitizer.ts`, 32 UTF-16 units
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
const BOUNDARY_END_CHAR = /^[\p{L}\p{N}’]$/u;
// HAP-only: HAP-NodeJS 2.2.2 requires the last character to be a letter/digit.
const HAP_BOUNDARY_END_CHAR = /^[\p{L}\p{N}]$/u;

/**
 * Longest raw name looked at, in code points. Names come from the panel, the
 * config or a `.ksa` backup and are never legitimately longer; the cap bounds
 * the work done on hostile input. Every pass below is linear anyway.
 */
const MAX_RAW_NAME_CODE_POINTS = 256;

/** Maximum HAP accessory name length (HomeKit allows up to 64 characters). */
export const HAP_MAX_NAME_LENGTH = 64;

/**
 * How a length limit is counted. HAP names count characters (code points).
 * Matter strings count UTF-16 code units, as Homebridge (`value.length`,
 * AccessoryManager.js:808-818) and matter.js (`value.length`,
 * @matter/node/dist/cjs/behavior/state/validation/constraint.js:162) do: a
 * letter outside the BMP takes two.
 */
export type NameLengthUnit = 'code-points' | 'utf16';

/**
 * Drops trailing characters that cannot end a name. A loop, not a `[...]+$`
 * regex: that one retries from every position of a long run of separators
 * and takes quadratic time.
 */
function trimEnd(characters: string[], isValidEnd: RegExp): string {
    let end = characters.length;
    while (end > 0 && !isValidEnd.test(characters[end - 1])) end -= 1;
    return characters.slice(0, end).join('');
}

/**
 * Truncate to `maxLength` (counted in `unit`) making sure the result still
 * ends with a valid boundary character (letter/digit/’) and never splits a
 * surrogate pair. Used for suffix head-truncation too.
 */
export function truncateDisplayName(name: string, maxLength: number, unit: NameLengthUnit = 'code-points'): string {
    const characters = Array.from(name);
    const kept: string[] = [];
    let length = 0;
    for (const character of characters) {
        length += unit === 'utf16' ? character.length : 1;
        if (length > maxLength) break;
        kept.push(character);
    }
    if (kept.length === characters.length) return name;
    return trimEnd(kept, BOUNDARY_END_CHAR);
}

/**
 * Core cleaning pass shared by the HAP and Matter sanitisers.
 * Returns '' when nothing usable survives (callers apply their fallback).
 */
export function cleanDisplayName(raw: string, maxLength: number, unit: NameLengthUnit = 'code-points'): string {
    let s = Array.from(raw).slice(0, MAX_RAW_NAME_CODE_POINTS).join('').normalize('NFKC');
    s = s.replace(/\+/g, ' e ');
    s = s.replace(/[()[\]]/g, ' ');
    s = s.replace(ALLOWED_MID_CHARS, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = trimEnd(Array.from(s.replace(BOUNDARY_LEFT, '')), BOUNDARY_END_CHAR);
    return truncateDisplayName(s, maxLength, unit);
}

function cleanHapName(raw: string): string {
    return trimEnd(Array.from(cleanDisplayName(raw, HAP_MAX_NAME_LENGTH)), HAP_BOUNDARY_END_CHAR);
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
