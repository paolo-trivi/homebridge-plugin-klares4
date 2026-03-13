import * as fs from 'fs';
import type { ParsedKsaProgram } from './types';

interface ParsedKsaRoot {
    DATA?: Record<string, unknown>;
}

export async function readAndParseKsaProgram(filePath: string): Promise<ParsedKsaProgram> {
    const raw = await fs.promises.readFile(filePath);
    return parseKsaProgramFromBuffer(raw);
}

export function parseKsaProgramFromBuffer(raw: Buffer): ParsedKsaProgram {
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

function findBalancedJsonObjectEnd(rawJsonSlice: Buffer): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < rawJsonSlice.length; index += 1) {
        const char = String.fromCharCode(rawJsonSlice[index]);
        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '{') {
            depth += 1;
            continue;
        }
        if (char === '}') {
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

function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}
