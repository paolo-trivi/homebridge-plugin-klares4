import { maskSensitiveData } from '../log-levels';

export const MASK = '***MASKED***';
const CUT = '***TRUNCATED***';

/** Frames from a real panel nest about seven levels deep; anything beyond this is cut, never recursed into. */
const MAX_DEPTH = 32;
/** Longest string that is looked into for JSON (a payload sent as a string). */
const MAX_NESTED_JSON_LENGTH = 1_048_576;

/** Where a value comes from: protocol frames use upper-case field names, snapshots the plugin's own. */
export type RedactionScope = 'in' | 'out' | 'snapshot';

/** Words that make a key a credential, whatever its case or prefix (`PIN`, `USER_PIN`, `4DIGIT_PIN`, `password`). */
const SECRET_WORDS = new Set(['pin', 'pwd', 'passwd', 'password', 'passcode', 'secret', 'token']);

/**
 * Keys, lower-cased, that identify the installation: the home position and what the
 * sunrise and sunset times of the panel would give away of it, the account and the
 * serial numbers of the bus devices. Taken from the field names of real captures.
 */
const IDENTITY_KEYS = new Set([
    'position', 'lat', 'long', 'lon', 'lng', 'latitude', 'longitude', 'dawn', 'dusk',
    'id_account', 'sn', 'serial',
]);

const isSecretKey = (key: string): boolean => {
    const lower = key.toLowerCase();
    return lower === 'code' || lower.split('_').some((word) => SECRET_WORDS.has(word));
};

function isSensitiveKey(key: string, scope: RedactionScope): boolean {
    if (isSecretKey(key) || IDENTITY_KEYS.has(key.toLowerCase())) return true;
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
        const sensitive = isSensitiveKey(key, walk.scope) && !isScenarioPinFlag(key, container, value);
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

/** A payload sent as a JSON string (`"PAYLOAD":"{\"PIN\":...}"`) is redacted inside and written back as a string. */
function redactNestedJson(text: string, container: string | undefined, depth: number, walk: Walk): string {
    const trimmed = text.trimStart();
    if ((trimmed[0] !== '{' && trimmed[0] !== '[') || text.length > MAX_NESTED_JSON_LENGTH || depth > MAX_DEPTH) return text;
    let inner: unknown;
    try {
        inner = JSON.parse(text);
    } catch {
        return text;
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
const SECRET_ASSIGNMENT = /(?<![A-Za-z0-9])(pin|pwd|passwd|password|passcode|secret|token)((?:\\?")?\s*[=:]\s*(?:\\?")?)[^\s"\\,}\]]*/gi;

/**
 * Fallback for what is not a JSON object (truncated, glued, prefixed or escaped
 * frames): without the structure the rules work on the text. Scalar values of
 * sensitive keys are masked, a credential word followed by `:` or `=` is masked
 * in any quoting, and a JSON string is looked into. Nested objects that start
 * under a sensitive key keep their own sensitive keys masked one by one.
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
        .replace(SECRET_ASSIGNMENT, (_whole: string, word: string, separator: string) => `${word}${separator}${MASK}`);
}
