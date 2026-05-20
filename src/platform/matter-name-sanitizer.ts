/**
 * Matter-only accessory name sanitisation.
 *
 * Normalises display names for Matter / Homebridge 2 controllers without
 * touching HAP names, UUIDs, or the original klares4 device names.
 *
 * Pure functions + a stateful collision registry (one instance per registry object).
 */

const MAX_NAME_LENGTH = 64;

/**
 * Sanitise a device name for use as a Matter accessory `displayName`.
 *
 * Rules (applied in order):
 *  1. Replace `+` with ` e `.
 *  2. Remove parentheses / brackets but keep their content.
 *  3. Normalise typographic apostrophes / single quotes to nothing.
 *  4. Replace slashes, backslashes and other shell-like special chars with space.
 *  5. Collapse multiple whitespace to a single space.
 *  6. Trim leading/trailing whitespace.
 *  7. Truncate to MAX_NAME_LENGTH characters (trim again after truncation).
 *  8. If the result is empty, use `fallback` (default 'Device').
 */
export function sanitizeMatterAccessoryName(name: string, fallback = 'Device'): string {
    if (!name || typeof name !== 'string') return fallback || 'Device';

    let s = name;
    s = s.replace(/\+/g, ' e ');
    s = s.replace(/[()[\]]/g, ' ');
    // Typographic apostrophes, right/left single quotes
    s = s.replace(/[\u2018\u2019\u201a\u201b']/g, '');
    // Slash, backslash, pipe and similar structural chars → space
    s = s.replace(/[/\\|<>{}*?!@#$%^&=~`]/g, ' ');
    s = s.replace(/\s+/g, ' ');
    s = s.trim();

    if (s.length > MAX_NAME_LENGTH) {
        s = s.slice(0, MAX_NAME_LENGTH).trim();
    }

    return s || (fallback.trim() || 'Device');
}

/**
 * Tracks sanitised names per registry instance so that two devices whose names
 * normalise to the same string receive distinct suffixes.
 *
 * Instantiate once per plugin boot (module-level in matter-device-mapper).
 * For tests, instantiate a fresh registry per test to avoid cross-test pollution.
 */
export class MatterNameRegistry {
    private readonly nameToUuid = new Map<string, string>();

    /**
     * Return `sanitized` if it has not been used yet (or was used by the same uuid).
     * Otherwise append a stable 4-char hex suffix derived from the uuid.
     */
    resolve(uuid: string, sanitized: string): string {
        const existing = this.nameToUuid.get(sanitized);
        if (!existing || existing === uuid) {
            this.nameToUuid.set(sanitized, uuid);
            return sanitized;
        }
        // Collision: derive a stable suffix from the last 4 chars of the uuid.
        const suffix = uuid.replace(/-/g, '').slice(-4);
        const candidate = sanitized.length + 5 <= MAX_NAME_LENGTH
            ? `${sanitized} ${suffix}`
            : `${sanitized.slice(0, MAX_NAME_LENGTH - 5).trim()} ${suffix}`;
        this.nameToUuid.set(candidate, uuid);
        return candidate;
    }
}
