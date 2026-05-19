import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';

const STORE_FILENAME = 'klares4-matter-fallback.json';

interface StoreShape {
    thermostatAsTemperatureSensor: string[];
}

/**
 * Persists the set of thermostat UUIDs that were registered as Matter
 * TemperatureSensors (fallback path). Survives child-bridge restarts so the
 * plugin and the Matter storage stay in sync — without this, after a restart
 * the plugin would push to `thermostat` cluster on an endpoint that the Matter
 * storage already committed as TemperatureSensor.
 */
export class MatterFallbackStore {
    private readonly filePath: string;
    private cache: Set<string> = new Set();
    private loaded = false;

    constructor(storagePath: string, private readonly log: Logger) {
        this.filePath = path.join(storagePath, STORE_FILENAME);
    }

    public load(): Set<string> {
        if (this.loaded) return this.cache;
        this.loaded = true;
        try {
            if (!fs.existsSync(this.filePath)) {
                this.cache = new Set();
                return this.cache;
            }
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<StoreShape>;
            const arr = Array.isArray(parsed.thermostatAsTemperatureSensor)
                ? parsed.thermostatAsTemperatureSensor.filter((x): x is string => typeof x === 'string')
                : [];
            this.cache = new Set(arr);
        } catch (err) {
            this.log.warn(`[Matter] Could not load fallback store (${this.filePath}): ${err instanceof Error ? err.message : String(err)}`);
            this.cache = new Set();
        }
        return this.cache;
    }

    public add(uuid: string): void {
        this.load();
        if (this.cache.has(uuid)) return;
        this.cache.add(uuid);
        this.write();
    }

    public remove(uuid: string): void {
        this.load();
        if (!this.cache.has(uuid)) return;
        this.cache.delete(uuid);
        this.write();
    }

    public has(uuid: string): boolean {
        this.load();
        return this.cache.has(uuid);
    }

    private write(): void {
        try {
            const payload: StoreShape = { thermostatAsTemperatureSensor: [...this.cache].sort() };
            fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
        } catch (err) {
            this.log.warn(`[Matter] Could not write fallback store (${this.filePath}): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
