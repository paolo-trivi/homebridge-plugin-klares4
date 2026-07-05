import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';
import type { MatterNameMapEntry } from './matter-name-map';

const STORE_FILENAME = 'klares4-matter-names.json';

interface StoreShape {
    version: 1;
    names: MatterNameMapEntry[];
}

/**
 * Persists the batch-computed Matter name-map (`klares4-matter-names.json` in
 * the Homebridge storage path, same pattern as `matter-fallback-store.ts`).
 *
 * Loaded at construction of the next boot so every accessory registers with
 * its *final* collision-resolved displayName from the very first
 * `registerPlatformAccessories` call — no post-registration rename window,
 * regardless of the order the WS discovery emits devices in.
 */
export class MatterNameStore {
    private readonly filePath: string;
    private lastSerialized: string | undefined;

    constructor(storagePath: string, private readonly log: Logger) {
        this.filePath = path.join(storagePath, STORE_FILENAME);
    }

    public load(): MatterNameMapEntry[] {
        try {
            if (!fs.existsSync(this.filePath)) return [];
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<StoreShape>;
            const names = Array.isArray(parsed.names) ? parsed.names : [];
            const entries = names.filter((e): e is MatterNameMapEntry =>
                !!e && typeof e === 'object'
                && typeof (e as MatterNameMapEntry).uuid === 'string' && !!(e as MatterNameMapEntry).uuid
                && typeof (e as MatterNameMapEntry).name === 'string' && !!(e as MatterNameMapEntry).name
                && typeof (e as MatterNameMapEntry).base === 'string',
            );
            this.lastSerialized = this.serialize(entries);
            return entries;
        } catch (err) {
            this.log.warn(`[Matter] Could not load name-map store (${this.filePath}): ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }

    /**
     * Persist the map. Returns true when the file content actually changed
     * (used to log "map updated" only on genuine panel-side changes).
     */
    public save(entries: MatterNameMapEntry[]): boolean {
        const serialized = this.serialize(entries);
        if (serialized === this.lastSerialized) return false;
        try {
            fs.writeFileSync(this.filePath, serialized, 'utf8');
            this.lastSerialized = serialized;
            return true;
        } catch (err) {
            this.log.warn(`[Matter] Could not write name-map store (${this.filePath}): ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }

    private serialize(entries: MatterNameMapEntry[]): string {
        const names = [...entries]
            .sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0))
            .map((e) => ({ uuid: e.uuid, name: e.name, base: e.base, ...(e.type ? { type: e.type } : {}) }));
        const payload: StoreShape = { version: 1, names };
        return JSON.stringify(payload, null, 2);
    }
}
