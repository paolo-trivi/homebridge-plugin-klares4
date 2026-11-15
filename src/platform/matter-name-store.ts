import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';
import { writeJsonAtomicSync } from '../atomic-file';
import type { MatterNameMapEntry } from './matter-name-map';
import { isValidMatterAccessoryName, priorityOf } from './matter-name-sanitizer';
import { toErrorMessage } from '../errors';

const STORE_FILENAME = 'klares4-matter-names.json';
const STORE_VERSION = 2;
/** How old the `lastSeen` on disk of a device still on the panel may get before the file is rewritten. */
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
 *
 * Every row is loaded whatever its age: a device still on the panel keeps its
 * name even after a long downtime. Only reservations (devices no longer
 * discovered) expire, 30 days after they were last seen
 * (`computeMatterNameMap`). `lastSeen` of the devices still on the panel is
 * written again once it is a day old, so a reservation always counts from the
 * last time the device was really seen.
 */
export class MatterNameStore {
    private readonly filePath: string;
    private lastSignature: string | undefined;
    private loadedVersion: number | undefined;
    private needsRewrite = false;
    /** Set when the file comes from a newer plugin version: it is never rewritten. */
    private readOnly = false;
    /** `lastSeen` of each row as it is on disk. */
    private readonly diskLastSeen = new Map<string, number>();

    constructor(storagePath: string, private readonly log: Logger) {
        this.filePath = path.join(storagePath, STORE_FILENAME);
    }

    public load(): MatterNameMapEntry[] {
        try {
            if (!fs.existsSync(this.filePath)) return [];
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<StoreShape>;
            if (typeof parsed.version === 'number' && parsed.version > STORE_VERSION) {
                this.readOnly = true;
                this.log.warn(
                    `[Matter] name-map ${this.filePath} was written by a newer plugin version (${parsed.version}); `
                    + 'it is ignored and left untouched. Names are recomputed for this session only.',
                );
                return [];
            }
            if (parsed.version !== 1 && parsed.version !== STORE_VERSION) {
                this.log.warn(`[Matter] Ignoring name-map with unsupported version ${String(parsed.version)}`);
                return [];
            }
            this.loadedVersion = parsed.version;
            const rawEntries = Array.isArray(parsed.names) ? parsed.names : [];
            const entries = this.validateEntries(rawEntries);
            this.needsRewrite = entries.length !== rawEntries.length || parsed.version !== STORE_VERSION;
            this.lastSignature = this.signature(entries);
            this.rememberDiskLastSeen(entries);
            return entries;
        } catch (err) {
            this.log.warn(`[Matter] Could not load name-map store (${this.filePath}): ${toErrorMessage(err)}`);
            return [];
        }
    }

    /**
     * Persist the map. Returns true when the file content actually changed
     * (used to log "map updated" only on genuine panel-side changes).
     */
    public save(entries: MatterNameMapEntry[], now = Date.now()): boolean {
        if (this.readOnly) return false;
        const refreshDue = entries.some((entry) => !entry.reserved && this.isStaleOnDisk(entry.uuid, now));
        const validEntries = this.validateEntries(entries);
        const signature = this.signature(validEntries);
        const changed = signature !== this.lastSignature;
        if (!changed && !refreshDue && !this.needsRewrite && this.loadedVersion === STORE_VERSION) return false;
        try {
            this.backupLegacyStore();
            writeJsonAtomicSync(this.filePath, this.serialize(validEntries));
            this.lastSignature = signature;
            this.loadedVersion = STORE_VERSION;
            this.needsRewrite = false;
            this.rememberDiskLastSeen(validEntries);
            return changed;
        } catch (err) {
            this.log.warn(`[Matter] Could not write name-map store (${this.filePath}): ${toErrorMessage(err)}`);
            return false;
        }
    }

    private isStaleOnDisk(uuid: string, now: number): boolean {
        const onDisk = this.diskLastSeen.get(uuid);
        return onDisk === undefined || now - onDisk >= REFRESH_INTERVAL_MS;
    }

    private rememberDiskLastSeen(entries: MatterNameMapEntry[]): void {
        this.diskLastSeen.clear();
        for (const entry of entries) {
            if (typeof entry.lastSeen === 'number') this.diskLastSeen.set(entry.uuid, entry.lastSeen);
        }
    }

    private serialize(entries: MatterNameMapEntry[]): StoreShape {
        const names = this.sorted(entries).map((entry) => ({
            uuid: entry.uuid,
            name: entry.name,
            base: entry.base,
            ...(entry.type ? { type: entry.type } : {}),
            ...(typeof entry.lastSeen === 'number' ? { lastSeen: entry.lastSeen } : {}),
        }));
        return { version: STORE_VERSION, names };
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
        if (typeof lastSeen !== 'number' || !Number.isFinite(lastSeen) || lastSeen < 0) return undefined;
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
