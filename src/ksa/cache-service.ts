import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';
import { writeJsonAtomic } from '../atomic-file';
import type { KsaSanitizedCache } from '../types';

const CACHE_FILE_NAME = 'klares4-ksa-cache.json';

const STRING_MAP_KEYS = [
    'thermostatProgramIdByOutputId',
    'domusSensorIdByThermostatProgramId',
    'outputNamesById',
    'zoneNamesById',
    'scenarioNamesById',
    'domusSensorNamesById',
    'roomNameById',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): boolean {
    return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

/**
 * Why a parsed cache cannot be used, or undefined when it is complete. A cache
 * edited by hand, partially written or produced by another version must be
 * ignored, not handed to the WebSocket client (which would throw while
 * reading a missing map and never connect).
 */
export function findKsaCacheProblem(parsed: unknown): string | undefined {
    if (!isPlainObject(parsed)) return 'not an object';
    const programs = parsed.thermostatPrograms;
    if (!Array.isArray(programs)) return 'thermostatPrograms is not an array';
    if (!programs.every((entry) => isPlainObject(entry) && typeof entry.id === 'string')) {
        return 'thermostatPrograms has an invalid entry';
    }
    for (const key of STRING_MAP_KEYS) {
        if (!isStringMap(parsed[key])) return `${key} is missing or invalid`;
    }
    if (!Array.isArray(parsed.roomDeviceRefs)) return 'roomDeviceRefs is not an array';
    return undefined;
}

export class KsaCacheService {
    private readonly cachePath: string;

    constructor(storagePath: string, private readonly log: Logger) {
        this.cachePath = path.join(storagePath, CACHE_FILE_NAME);
    }

    public get path(): string {
        return this.cachePath;
    }

    public async save(cache: KsaSanitizedCache): Promise<void> {
        await writeJsonAtomic(this.cachePath, cache, 2);
    }

    public async load(): Promise<KsaSanitizedCache | undefined> {
        try {
            const raw = await fs.promises.readFile(this.cachePath, 'utf8');
            const parsed: unknown = JSON.parse(raw);
            const problem = findKsaCacheProblem(parsed);
            if (problem) {
                this.log.warn(`Ignoring KSA cache ${this.cachePath}: ${problem}. Re-run the KSA import to rebuild it.`);
                return undefined;
            }
            return parsed as KsaSanitizedCache;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('ENOENT')) {
                this.log.warn(`Unable to load KSA cache: ${message}`);
            }
            return undefined;
        }
    }
}
