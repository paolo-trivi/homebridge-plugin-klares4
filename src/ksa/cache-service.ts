import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';
import type { KsaSanitizedCache } from '../types';

const CACHE_FILE_NAME = 'klares4-ksa-cache.json';

export class KsaCacheService {
    private readonly cachePath: string;

    constructor(storagePath: string, private readonly log: Logger) {
        this.cachePath = path.join(storagePath, CACHE_FILE_NAME);
    }

    public get path(): string {
        return this.cachePath;
    }

    public async save(cache: KsaSanitizedCache): Promise<void> {
        await fs.promises.writeFile(this.cachePath, JSON.stringify(cache, null, 2), 'utf8');
    }

    public async load(): Promise<KsaSanitizedCache | undefined> {
        try {
            const raw = await fs.promises.readFile(this.cachePath, 'utf8');
            const parsed = JSON.parse(raw) as KsaSanitizedCache;
            if (!parsed || typeof parsed !== 'object') {
                return undefined;
            }
            if (!Array.isArray(parsed.thermostatPrograms)) {
                return undefined;
            }
            return parsed;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('ENOENT')) {
                this.log.warn(`Unable to load KSA cache: ${message}`);
            }
            return undefined;
        }
    }
}
