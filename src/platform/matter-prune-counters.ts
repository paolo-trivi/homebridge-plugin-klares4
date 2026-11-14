import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';
import { writeJsonAtomicSync } from '../atomic-file';

const COUNTER_STORE_FILENAME = 'klares4-matter-prune.json';

interface CounterStoreShape {
    version: 1;
    missing: Record<string, number>;
}

/**
 * Consecutive missed syncs per Matter endpoint UUID.
 *
 * When `storagePath` is provided the counters persist across restarts
 * (`klares4-matter-prune.json`). Without persistence a stable setup runs one
 * prune cycle per boot, the counter restarts from zero every time and a
 * genuinely stale endpoint would survive forever. A file written by a newer
 * plugin version is read-only: counters then live in memory only.
 */
export class MatterPruneCounters {
    private readonly counts = new Map<string, number>();
    private readonly filePath?: string;
    private dirty = false;
    private readOnly = false;

    constructor(private readonly log: Logger, storagePath?: string) {
        if (storagePath) {
            this.filePath = path.join(storagePath, COUNTER_STORE_FILENAME);
            this.load();
        }
    }

    public get(uuid: string): number {
        return this.counts.get(uuid) ?? 0;
    }

    public set(uuid: string, missed: number): void {
        this.counts.set(uuid, missed);
        this.dirty = true;
    }

    /** Returns whether a counter existed. */
    public delete(uuid: string): boolean {
        if (!this.counts.delete(uuid)) return false;
        this.dirty = true;
        return true;
    }

    /** Drops the counters of UUIDs the plugin no longer holds anywhere; returns them. */
    public retainOnly(isHeld: (uuid: string) => boolean): string[] {
        const orphans = [...this.counts.keys()].filter((uuid) => !isHeld(uuid));
        for (const uuid of orphans) this.delete(uuid);
        return orphans;
    }

    public saveIfDirty(): void {
        if (!this.filePath || !this.dirty || this.readOnly) return;
        this.dirty = false;
        try {
            const payload: CounterStoreShape = {
                version: 1,
                missing: Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
            };
            writeJsonAtomicSync(this.filePath, payload, 2);
        } catch (err) {
            this.log.warn(`[Matter] Could not write prune-counter store (${this.filePath}): ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private load(): void {
        if (!this.filePath) return;
        try {
            if (!fs.existsSync(this.filePath)) return;
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<CounterStoreShape>;
            if (parsed && typeof parsed.version === 'number' && parsed.version > 1) {
                this.readOnly = true;
                this.log.warn(
                    `[Matter] Prune-counter store ${this.filePath} has unsupported version ${String(parsed.version)}; `
                    + 'it will not be modified. Counters are kept in memory for this session.',
                );
                return;
            }
            if (!parsed.missing || typeof parsed.missing !== 'object') return;
            for (const [uuid, count] of Object.entries(parsed.missing)) {
                if (typeof count === 'number' && Number.isInteger(count) && count > 0) {
                    this.counts.set(uuid, count);
                }
            }
        } catch (err) {
            this.log.warn(`[Matter] Could not load prune-counter store (${this.filePath}): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
