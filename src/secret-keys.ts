/**
 * Which JSON keys carry a secret or identify the installation, whatever their
 * spelling: `PIN`, `USER_PIN`, `userPin`, `PINCODE`, `PIN-CODE`, `pin1`. The
 * key is split into words (separators, camelCase, digits) and each word is
 * compared with a family; a word glued to a modifier or a suffix (`USERPIN`,
 * `PINCODE`, `serialnumber`) counts as well. A key that merely contains the
 * letters (`PING`, `MACHINE`, `COMPASS`, `PASSIVE`) does not. Shared by the log
 * mask and the debug-file redaction so the two cannot drift apart.
 */

/** Credentials. */
const CREDENTIAL_STEMS = 'pin|pwd|passwd|password|passcode|pass|secret|token';
/** What identifies a device or a person, not a place (places are handled by the redaction). */
const IDENTITY_STEMS = 'serial|mac|imei|iccid|email|sn';

const MODIFIERS = 'user|admin|master|installer|owner|old|new|my|access|security|auth|unlock|device|panel|client|app|sys|system|api';
const SUFFIXES = 'code|number|num|no|value|key|digits|hash|address|addr';

const family = (stems: string): RegExp => new RegExp(`^(?:${MODIFIERS})?(?:${stems})(?:${SUFFIXES})?$`);
const CREDENTIAL = family(CREDENTIAL_STEMS);
const IDENTITY = family(IDENTITY_STEMS);

/** `code` alone is a credential, `ERROR_CODE` or `RESULT_CODE` is a status: it needs one of these before it. */
const CODE_QUALIFIERS = new Set(['pin', 'pass', 'user', 'access', 'security', 'auth', 'unlock', 'master', 'installer', 'admin']);
const QUALIFIED_CODE = new RegExp(`^(?:${[...CODE_QUALIFIERS].join('|')})code$`);

function words(key: string): string[] {
    return key
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([A-Za-z])(\d)/g, '$1 $2')
        .replace(/(\d)([A-Za-z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter((word) => word !== '' && !/^\d+$/.test(word))
        .map((word) => word.toLowerCase());
}

/**
 * Frames repeat a few dozen key names thousands of times: the verdict is cached per key.
 * The cache is bounded, so a stream of odd keys cannot grow it without limit.
 */
const MAX_CACHED_KEYS = 2048;

function memoized(classify: (key: string) => boolean): (key: string) => boolean {
    const verdicts = new Map<string, boolean>();
    return (key: string): boolean => {
        const known = verdicts.get(key);
        if (known !== undefined) return known;
        const verdict = classify(key);
        if (verdicts.size >= MAX_CACHED_KEYS) verdicts.clear();
        verdicts.set(key, verdict);
        return verdict;
    };
}

export const isCredentialKey = memoized((key: string): boolean => {
    const parts = words(key);
    return parts.some((word, i) => CREDENTIAL.test(word) || QUALIFIED_CODE.test(word)
        || (word === 'code' && (parts.length === 1 || CODE_QUALIFIERS.has(parts[i - 1] ?? ''))));
});

export const isIdentityKey = memoized((key: string): boolean => words(key).some((word) => IDENTITY.test(word)));
