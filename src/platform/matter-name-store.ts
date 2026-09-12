import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';
import type { MatterNameMapEntry } from './matter-name-map';
import { isValidMatterAccessoryName, priorityOf } from './matter-name-sanitizer';

const STORE_FILENAME = 'klares4-matter-names.json';
const STORE_VERSION = 2;
const RESERVATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const KNOWN_TYPES = new Set(['zone', 'sensor', 'cover', 'light', 'thermostat', 'scenario', 'gate']);

interface StoreShape {
    version: number;
    names: unknown[];
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
    private loadedVersion: number | undefined;
    private needsRewrite = false;

    constructor(storagePath: string, private readonly log: Logger) {
        this.filePath = path.join(storagePath, STORE_FILENAME);
    }

    public load(): MatterNameMapEntry[] {
        try {
            if (!fs.existsSync(this.filePath)) return [];
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<StoreShape>;
            if (parsed.version !== 1 && parsed.version !== STORE_VERSION) {
                this.log.warn(`[Matter] Ignoring name-map with unsupported version ${String(parsed.version)}`);
                return [];
            }
            this.loadedVersion = parsed.version;
            const rawEntries = Array.isArray(parsed.names) ? parsed.names : [];
            const entries = this.validateEntries(rawEntries);
            this.needsRewrite = entries.length !== rawEntries.length || parsed.version !== STORE_VERSION;
            this.lastSignature = this.signature(entries);
            this.lastWriteAt = Date.now();
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
        const validEntries = this.validateEntries(entries);
        const signature = this.signature(validEntries);
        const changed = signature !== this.lastSignature;
        const refreshDue = Date.now() - this.lastWriteAt >= REFRESH_INTERVAL_MS;
        if (!changed && !refreshDue && !this.needsRewrite && this.loadedVersion === STORE_VERSION) return false;
        try {
            this.backupLegacyStore();
            const temporaryPath = `${this.filePath}.tmp`;
            fs.writeFileSync(temporaryPath, this.serialize(validEntries), 'utf8');
            fs.renameSync(temporaryPath, this.filePath);
            this.lastSignature = signature;
            this.lastWriteAt = Date.now();
            this.loadedVersion = STORE_VERSION;
            this.needsRewrite = false;
            return changed;
        } catch (err) {
            this.log.warn(`[Matter] Could not write name-map store (${this.filePath}): ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }

    private serialize(entries: MatterNameMapEntry[]): string {
        const names = this.sorted(entries).map((entry) => ({
            uuid: entry.uuid,
            name: entry.name,
            base: entry.base,
            ...(entry.type ? { type: entry.type } : {}),
            ...(typeof entry.lastSeen === 'number' ? { lastSeen: entry.lastSeen } : {}),
        }));
        const payload: StoreShape = { version: STORE_VERSION, names };
        return JSON.stringify(payload, null, 2);
    }

    private validateEntries(entries: unknown[]): MatterNameMapEntry[] {
        const now = Date.now();
        const candidates = entries
            .map((entry) => this.parseEntry(entry, now))
            .filter((entry): entry is MatterNameMapEntry => entry !== undefined)
            .sort((a, b) => {
                const priority = priorityOf(b.type) - priorityOf(a.type);
                return priority || a.uuid.localeCompare(b.uuid);
            });
        const uuids = new Set<string>();
        const names = new Set<string>();
        const valid: MatterNameMapEntry[] = [];
        for (const entry of candidates) {
            const nameKey = entry.name.toLowerCase();
            if (uuids.has(entry.uuid) || names.has(nameKey)) continue;
            uuids.add(entry.uuid);
            names.add(nameKey);
            valid.push(entry);
        }
        const skipped = entries.length - valid.length;
        if (skipped > 0) this.log.warn(`[Matter] name-map ignored ${skipped} invalid or duplicate entry(s)`);
        return valid;
    }

    private parseEntry(value: unknown, now: number): MatterNameMapEntry | undefined {
        if (!value || typeof value !== 'object') return undefined;
        const entry = value as Partial<MatterNameMapEntry>;
        if (typeof entry.uuid !== 'string' || !entry.uuid.trim()) return undefined;
        if (typeof entry.name !== 'string' || !isValidMatterAccessoryName(entry.name)) return undefined;
        if (typeof entry.base !== 'string' || !isValidMatterAccessoryName(entry.base)) return undefined;
        if (entry.type !== undefined && !KNOWN_TYPES.has(entry.type)) return undefined;
        if (this.loadedVersion === STORE_VERSION && entry.lastSeen === undefined) return undefined;
        const lastSeen = entry.lastSeen === undefined ? now : entry.lastSeen;
        if (lastSeen !== undefined && (!Number.isFinite(lastSeen) || (lastSeen as number) < 0)) return undefined;
        if (typeof lastSeen === 'number' && now - lastSeen >= RESERVATION_TTL_MS) return undefined;
        return { uuid: entry.uuid, name: entry.name, base: entry.base, type: entry.type, lastSeen };
    }

    private signature(entries: MatterNameMapEntry[]): string {
        return JSON.stringify(this.sorted(entries).map((entry) => ({
            uuid: entry.uuid,
            name: entry.name,
            base: entry.base,
            type: entry.type,
        })));
    }

    private sorted(entries: MatterNameMapEntry[]): MatterNameMapEntry[] {
        return [...entries].sort((a, b) => a.uuid.localeCompare(b.uuid));
    }

    private backupLegacyStore(): void {
        if (this.loadedVersion !== 1 || !fs.existsSync(this.filePath)) return;
        const backupPath = `${this.filePath}.v1.bak`;
        if (!fs.existsSync(backupPath)) fs.copyFileSync(this.filePath, backupPath);
    }
}
