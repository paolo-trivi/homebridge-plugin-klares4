import { maskSensitiveData } from '../log-levels';
import { isCredentialKey, isIdentityKey } from '../secret-keys';

export const MASK = '***MASKED***';
const CUT = '***TRUNCATED***';

/** Frames from a real panel nest about seven levels deep; anything beyond this is cut, never recursed into. */
const MAX_DEPTH = 32;
/** Longest string that is looked into for JSON (a payload sent as a string). */
const MAX_NESTED_JSON_LENGTH = 1_048_576;

/** Where a value comes from: protocol frames use upper-case field names, snapshots the plugin's own. */
export type RedactionScope = 'in' | 'out' | 'snapshot';

/**
 * Keys, lower-cased, that identify the installation: where it is, what the sunrise
 * and sunset times of the panel would give away of it, and the account. Credentials
 * and serial-like identifiers are families (`secret-keys.ts`). Taken from the field
 * names of real captures.
 */
const IDENTITY_KEYS = new Set(['lat', 'long', 'lon', 'lng', 'latitude', 'longitude', 'dawn', 'dusk', 'id_account']);

/**
 * The home position is `POSITION` (an object with `LAT` and `LONG`) in the login answer. A
 * device's own `position` is a number, the opening of a cover (frames carry it as `POS`),
 * and is state. So in frames `POSITION` is always masked; in a device snapshot only a
 * value that is not a plain number is.
 */
function isPlace(key: string, value: unknown, scope: RedactionScope): boolean {
    if (key.toLowerCase() !== 'position') return false;
    return scope !== 'snapshot' || typeof value !== 'number' || !Number.isFinite(value);
}

function isSensitiveKey(key: string, scope: RedactionScope, value?: unknown): boolean {
    if (isCredentialKey(key) || isIdentityKey(key) || IDENTITY_KEYS.has(key.toLowerCase())) return true;
    if (isPlace(key, value, scope)) return true;
    // The account description of a LOGIN_RES; a device snapshot's own `description` is the device's and stays.
    return scope !== 'snapshot' && key === 'DESCRIPTION';
}

/** `SCENARIOS[].PIN` is a one-to-three letter flag (does the scenario need a PIN), not a credential. */
function isScenarioPinFlag(key: string, ownerKey: string | undefined, value: unknown): boolean {
    return key === 'PIN' && ownerKey === 'SCENARIOS' && typeof value === 'string' && /^[A-Z]{1,3}$/.test(value);
}

interface Walk {
    scope: RedactionScope;
    changed: boolean;
}

function redactNode(value: unknown, key: string | undefined, container: string | undefined, depth: number, walk: Walk): unknown {
    if (key !== undefined) {
        const sensitive = isSensitiveKey(key, walk.scope, value) && !isScenarioPinFlag(key, container, value);
        // Incoming frames are signed by the panel itself: its identifier is not ours to publish.
        if (sensitive || (walk.scope === 'in' && depth === 1 && key === 'SENDER')) {
            walk.changed = true;
            return MASK;
        }
    }
    if (typeof value === 'string') return redactNestedJson(value, key ?? container, depth, walk);
    if (typeof value !== 'object' || value === null) return value;
    if (depth > MAX_DEPTH) {
        walk.changed = true;
        return CUT;
    }
    const owner = key ?? container;
    if (Array.isArray(value)) return value.map((item) => redactNode(item, undefined, owner, depth + 1, walk));
    // fromEntries defines own properties: a key named `__proto__` stays data.
    return Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, redactNode(child, name, owner, depth + 1, walk)]),
    );
}

/**
 * A payload sent as a JSON string (`"PAYLOAD":"{\"PIN\":...}"`) is redacted inside and written
 * back as a string. One that is too long, too deep or does not parse is masked as text: it is
 * never passed through just because it could not be understood.
 */
function redactNestedJson(text: string, container: string | undefined, depth: number, walk: Walk): string {
    const trimmed = text.trimStart();
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return text;
    let inner: unknown;
    try {
        if (text.length > MAX_NESTED_JSON_LENGTH || depth > MAX_DEPTH) throw new RangeError('not looked into');
        inner = JSON.parse(text);
    } catch {
        const masked = redactText(text);
        if (masked !== text) walk.changed = true;
        return masked;
    }
    const nested: Walk = { scope: walk.scope, changed: false };
    const redacted = redactNode(inner, undefined, container, depth + 1, nested);
    if (!nested.changed) return text;
    walk.changed = true;
    return JSON.stringify(redacted);
}

/** Redacts a parsed frame by key at any depth. `changed` tells whether the text has to be written again. */
export function redactFrame(
    frame: Record<string, unknown>,
    direction: 'in' | 'out',
): { value: Record<string, unknown>; changed: boolean } {
    const walk: Walk = { scope: direction, changed: false };
    const value = redactNode(frame, undefined, undefined, 0, walk);
    return { value: isPlainRecord(value) ? value : {}, changed: walk.changed };
}

/** Same rules for the device snapshots; the device names and states stay. */
export function redactSnapshot(devices: unknown): unknown {
    return redactNode(devices, undefined, undefined, 0, { scope: 'snapshot', changed: false });
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const QUOTED_PAIR = /"((?:[^"\\]|\\.)*)"(\s*:\s*)("(?:[^"\\]|\\.)*(?:"|$)|-?\d[\d.eE+-]*|true|false|null)/g;
/** `key: value`, `key=value`, `'key': 'value'`, `\"key\":\"value\"`: any quoting, the key read as one token. */
const ASSIGNMENT = /([A-Za-z0-9_.-]+)((?:\\?["'])?\s*[=:]\s*(?:\\?["'])?)([^\s"'\\,{}[\]]+)/g;
/** `PIN 1234`: a credential word and the token after it. */
const SPOKEN_SECRET = /(?<![A-Za-z0-9])(pin|pwd|passwd|password|passcode|secret|token)(\s+)[^\s"'\\,}\]]+/gi;

/**
 * Fallback for what is not a JSON object (truncated, glued, prefixed or escaped
 * frames): without the structure the rules work on the text. Scalar values of
 * sensitive keys are masked, a key followed by `:` or `=` is masked in any quoting,
 * a credential word followed by a space masks the next token, and a JSON string
 * is looked into. Nested objects that start under a sensitive key keep their own
 * sensitive keys masked one by one.
 */
export function redactText(text: string): string {
    let inner: unknown;
    try {
        inner = JSON.parse(text);
    } catch {
        inner = undefined;
    }
    if (typeof inner === 'string') return JSON.stringify(redactText(inner));
    return maskSensitiveData(text)
        .replace(QUOTED_PAIR, (whole: string, key: string, separator: string) =>
            (isSensitiveKey(key, 'in') ? `"${key}"${separator}"${MASK}"` : whole))
        .replace(ASSIGNMENT, (whole: string, key: string, separator: string) =>
            (isSensitiveKey(key, 'in') ? `${key}${separator}${MASK}` : whole))
        .replace(SPOKEN_SECRET, (_whole: string, word: string, space: string) => `${word}${space}${MASK}`);
}
