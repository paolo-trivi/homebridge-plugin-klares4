import type { ParsedKsaProgram } from './types';

/** A real panel backup is well under 1 MB; the whole file is parsed in memory on the event loop. */
export const MAX_KSA_FILE_BYTES = 32 * 1024 * 1024;

interface ParsedKsaRoot {
    DATA?: Record<string, unknown>;
}

export function parseKsaProgramFromBuffer(raw: Buffer): ParsedKsaProgram {
    assertKsaFileSize(raw.length);
    const root = parseEmbeddedRoot(raw);
    const data = asObject(root.DATA);
    return {
        outputs: asArray(data.PRG_OUTPUTS),
        zones: asArray(data.PRG_ZONES),
        scenarios: asArray(data.PRG_SCENARIOS),
        busHas: asArray(data.PRG_BUS_HAS),
        thermostats: asArray(data.PRG_THERMOSTATS),
        rooms: asArray(data.PRG_ROOMS),
        maps: asArray(data.PRG_MAPS),
    };
}

export function assertKsaFileSize(bytes: number): void {
    if (bytes > MAX_KSA_FILE_BYTES) {
        const megabytes = (bytes / (1024 * 1024)).toFixed(1);
        throw new Error(`KSA file is too large (${megabytes} MB; the limit is ${MAX_KSA_FILE_BYTES / (1024 * 1024)} MB)`);
    }
}

function parseEmbeddedRoot(raw: Buffer): ParsedKsaRoot {
    const start = raw.indexOf(Buffer.from('{"INFO"'));
    if (start < 0) {
        throw new Error('KSA parsing failed: JSON payload marker not found');
    }
    const jsonSlice = raw.subarray(start);
    const end = findBalancedJsonObjectEnd(jsonSlice);
    const payload = jsonSlice.subarray(0, end).toString('utf8');
    return JSON.parse(payload) as ParsedKsaRoot;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

/** Scans bytes: in UTF-8 no byte of a multi-byte character equals an ASCII delimiter. */
function findBalancedJsonObjectEnd(rawJsonSlice: Buffer): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < rawJsonSlice.length; index += 1) {
        const byte = rawJsonSlice[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (byte === BACKSLASH) {
                escaped = true;
            } else if (byte === QUOTE) {
                inString = false;
            }
            continue;
        }
        if (byte === QUOTE) {
            inString = true;
        } else if (byte === OPEN_BRACE) {
            depth += 1;
        } else if (byte === CLOSE_BRACE) {
            depth -= 1;
            if (depth === 0) {
                return index + 1;
            }
        }
    }
    throw new Error('KSA parsing failed: unterminated embedded JSON payload');
}

function asObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value as Record<string, unknown>;
}

/** Only object entries: a null or scalar in a PRG_* array is dropped, not dereferenced. */
function asArray<T>(value: unknown): T[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry)) as T[];
}
