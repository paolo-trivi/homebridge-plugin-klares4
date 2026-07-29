import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';
import type { MatterNameMapEntry } from './matter-name-map';

const STORE_FILENAME = 'klares4-matter-names.json';

/**
 * How long a name slot stays reserved for a uuid that is no longer being
 * discovered. Long by design: holding a slot only affects how *namesakes* are
 * suffixed, so over-keeping is harmless, while dropping too early is what lets
 * a lower-priority namesake steal a clean voice-command name. Devices really
 * deleted from the panel free their slot after this window.
 */
export const MATTER_NAME_RESERVATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    private lastSignature: string | undefined;
    private lastWriteAt = 0;

    /**
     * A stable setup produces an identical map every sync, so nothing would be
     * rewritten and the `lastSeen` stamps would age until the TTL expired
     * slots that are in fact in daily use. Rewrite at least this often to keep
     * them fresh — well inside `MATTER_NAME_RESERVATION_TTL_MS`.
     */
    private static readonly REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

    constructor(storagePath: string, private readonly log: Logger) {
        this.filePath = path.join(storagePath, STORE_FILENAME);
    }

    public load(): MatterNameMapEntry[] {
        try {
            if (!fs.existsSync(this.filePath)) return [];
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<StoreShape>;
            const names = Array.isArray(parsed.names) ? parsed.names : [];
            const wellFormed = names.filter((e): e is MatterNameMapEntry =>
                !!e && typeof e === 'object'
                && typeof (e as MatterNameMapEntry).uuid === 'string' && !!(e as MatterNameMapEntry).uuid
                && typeof (e as MatterNameMapEntry).name === 'string' && !!(e as MatterNameMapEntry).name
                && typeof (e as MatterNameMapEntry).base === 'string',
            );
            // Entries written before `lastSeen` existed count as just-seen, so
            // upgrading never expires a slot that is still in daily use.
            const now = Date.now();
            const entries = wellFormed.filter((e) => {
                if (typeof e.lastSeen !== 'number' || !Number.isFinite(e.lastSeen)) return true;
                return now - e.lastSeen < MATTER_NAME_RESERVATION_TTL_MS;
            });
            const expired = wellFormed.length - entries.length;
            if (expired > 0) {
                this.log.info(`[Matter] name-map: released ${expired} reserved slot(s) unseen for over 30 days`);
            }
            this.lastSignature = this.signature(entries);
            this.lastWriteAt = Date.now();
            return entries;
        } catch (err) {
            this.log.warn(`[Matter] Could not load name-map store (${this.filePath}): ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }

    /**
     * Persist the map. Returns true when the *mapping* actually changed (used
     * to log "map updated" only on genuine panel-side changes). A write may
     * still happen with a false return when only the `lastSeen` stamps need
     * refreshing — that is bookkeeping, not a change worth announcing.
     */
    public save(entries: MatterNameMapEntry[]): boolean {
        const signature = this.signature(entries);
        const changed = signature !== this.lastSignature;
        const refreshDue = Date.now() - this.lastWriteAt >= MatterNameStore.REFRESH_INTERVAL_MS;
        if (!changed && !refreshDue) return false;
        try {
            fs.writeFileSync(this.filePath, this.serialize(entries), 'utf8');
            this.lastSignature = signature;
            this.lastWriteAt = Date.now();
            return changed;
        } catch (err) {
            this.log.warn(`[Matter] Could not write name-map store (${this.filePath}): ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }

    private sorted(entries: MatterNameMapEntry[]): MatterNameMapEntry[] {
        return [...entries].sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
    }

    /**
     * Change-detection key: the mapping itself, without the `lastSeen` stamps
     * (which move on every sync) and without `reserved` (which is recomputed
     * from presence on each finalize, not a property of the stored slot).
     */
    private signature(entries: MatterNameMapEntry[]): string {
        return JSON.stringify(this.sorted(entries)
            .map((e) => ({ uuid: e.uuid, name: e.name, base: e.base, ...(e.type ? { type: e.type } : {}) })));
    }

    private serialize(entries: MatterNameMapEntry[]): string {
        const names = this.sorted(entries).map((e) => ({
            uuid: e.uuid,
            name: e.name,
            base: e.base,
            ...(e.type ? { type: e.type } : {}),
            ...(typeof e.lastSeen === 'number' ? { lastSeen: e.lastSeen } : {}),
        }));
        const payload: StoreShape = { version: 1, names };
        return JSON.stringify(payload, null, 2);
    }
}
