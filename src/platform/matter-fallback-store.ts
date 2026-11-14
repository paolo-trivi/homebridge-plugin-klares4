import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';
import { writeJsonAtomicSync } from '../atomic-file';
import { PLUGIN_VERSION_RAW } from '../plugin-version';
import { THERMOSTAT_SHAPE_REVISION } from './matter-thermostat-shape';

const STORE_FILENAME = 'klares4-matter-fallback.json';
const STORE_VERSION = 2;

export interface MatterFallbackRecord {
    deviceId: string;
    mode: 'fallback' | 'retrying' | 'native';
    reason: string;
    attempts: number;
    lastFailureAt?: string;
    lastProcessedRecoveryRequest?: number;
    /**
     * Revision of the Thermostat payload (`THERMOSTAT_SHAPE_REVISION`) of the
     * last native attempt. Absent in records written before 2.3.0: those
     * fallbacks came from a payload the runtime refused, and get one automatic
     * attempt with the current payload.
     */
    nativeShapeRevision?: number;
    pluginVersion: string;
}

interface StoreShapeV2 {
    version: 2;
    thermostats: MatterFallbackRecord[];
}

type Loaded =
    | { kind: 'v2'; records: unknown[] }
    | { kind: 'legacy'; ids: unknown[] }
    | { kind: 'foreign'; why: string }
    | { kind: 'unreadable'; why: string };

/** Classifies the file without trusting its shape. Only an exact v2 or the v1 shape is ours to rewrite. */
function classify(raw: string): Loaded {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error: unknown) {
        return { kind: 'unreadable', why: error instanceof Error ? error.message : String(error) };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unreadable', why: 'not a JSON object' };
    const obj = parsed as Record<string, unknown>;
    if (!('version' in obj)) {
        const legacy = obj.thermostatAsTemperatureSensor;
        return { kind: 'legacy', ids: Array.isArray(legacy) ? legacy : [] };
    }
    if (obj.version !== STORE_VERSION) return { kind: 'foreign', why: `unsupported version ${JSON.stringify(obj.version)}` };
    if (!Array.isArray(obj.thermostats)) return { kind: 'foreign', why: 'version 2 without a thermostats list' };
    return { kind: 'v2', records: obj.thermostats };
}

export class MatterFallbackStore {
    private readonly filePath: string;
    private readonly records = new Map<string, MatterFallbackRecord>();
    private loaded = false;
    private loadedLegacy = false;
    /** Set when the file is not one this version wrote or migrates: it is never rewritten. */
    private readOnly = false;

    constructor(storagePath: string, private readonly log: Logger) {
        this.filePath = path.join(storagePath, STORE_FILENAME);
    }

    public load(): Set<string> {
        this.ensureLoaded();
        const fallbackIds = new Set<string>();
        for (const record of this.records.values()) {
            if (record.mode === 'fallback') fallbackIds.add(record.deviceId);
        }
        return fallbackIds;
    }

    /** Explicit `matterRecoveryRequests` generation: one attempt per generation. */
    public beginRecovery(deviceId: string, request: number): boolean {
        this.ensureLoaded();
        const record = this.records.get(deviceId);
        if (!record || record.mode !== 'fallback') return false;
        if (!Number.isInteger(request) || request <= 0) return false;
        if ((record.lastProcessedRecoveryRequest ?? 0) >= request) return false;
        record.lastProcessedRecoveryRequest = request;
        this.startAttempt(record);
        return true;
    }

    /** True for a fallback that never tried the current Thermostat payload. */
    public needsAutomaticRecovery(deviceId: string): boolean {
        this.ensureLoaded();
        const record = this.records.get(deviceId);
        return record?.mode === 'fallback' && (record.nativeShapeRevision ?? 0) < THERMOSTAT_SHAPE_REVISION;
    }

    /** The one automatic attempt for a fallback persisted by an older payload. */
    public beginAutomaticRecovery(deviceId: string): boolean {
        if (!this.needsAutomaticRecovery(deviceId)) return false;
        this.startAttempt(this.records.get(deviceId) as MatterFallbackRecord);
        return true;
    }

    public add(deviceId: string, reason = 'registration-failure'): void {
        this.ensureLoaded();
        const existing = this.records.get(deviceId);
        this.records.set(deviceId, {
            deviceId,
            mode: 'fallback',
            reason,
            attempts: existing?.attempts ?? 0,
            lastFailureAt: new Date().toISOString(),
            lastProcessedRecoveryRequest: existing?.lastProcessedRecoveryRequest,
            // A fallback decided now was decided with the current payload.
            nativeShapeRevision: Math.max(existing?.nativeShapeRevision ?? 0, THERMOSTAT_SHAPE_REVISION),
            pluginVersion: PLUGIN_VERSION_RAW,
        });
        this.write();
    }

    public markNative(deviceId: string): void {
        this.ensureLoaded();
        const existing = this.records.get(deviceId);
        if (!existing) return;
        this.records.set(deviceId, { ...existing, mode: 'native', reason: 'recovered' });
        this.write();
    }

    public remove(deviceId: string): void {
        this.ensureLoaded();
        if (!this.records.delete(deviceId)) return;
        this.write();
    }

    public has(deviceId: string): boolean {
        this.ensureLoaded();
        return this.records.get(deviceId)?.mode === 'fallback';
    }

    public getRecord(deviceId: string): MatterFallbackRecord | undefined {
        this.ensureLoaded();
        const record = this.records.get(deviceId);
        return record ? { ...record } : undefined;
    }

    private startAttempt(record: MatterFallbackRecord): void {
        record.mode = 'retrying';
        record.attempts += 1;
        record.nativeShapeRevision = THERMOSTAT_SHAPE_REVISION;
        record.pluginVersion = PLUGIN_VERSION_RAW;
        this.write();
    }

    /**
     * Reads the file once per process. A record still `retrying` is a recovery
     * a previous process did not finish (crash or restart mid-attempt): it goes
     * back to fallback here, once, and not on later calls of this process,
     * which may hold a recovery of their own in progress.
     */
    private ensureLoaded(): void {
        if (this.loaded) return;
        this.loaded = true;
        let interrupted = false;
        for (const record of this.readRecords()) {
            if (record.mode === 'retrying') {
                record.mode = 'fallback';
                record.reason = 'interrupted-recovery';
                record.lastFailureAt = new Date().toISOString();
                interrupted = true;
            }
            this.records.set(record.deviceId, record);
        }
        if (interrupted) this.write();
    }

    private readRecords(): MatterFallbackRecord[] {
        let raw: string;
        try {
            if (!fs.existsSync(this.filePath)) return [];
            raw = fs.readFileSync(this.filePath, 'utf8');
        } catch (error: unknown) {
            this.readOnly = true;
            this.log.warn(`[Matter] Could not read fallback store (${this.filePath}): ${error instanceof Error ? error.message : String(error)}; it will not be modified.`);
            return [];
        }
        const loaded = classify(raw);
        switch (loaded.kind) {
            case 'v2':
                return loaded.records.flatMap((value) => {
                    const record = toRecord(value);
                    return record ? [record] : [];
                });
            case 'legacy':
                this.loadedLegacy = true;
                return loaded.ids.filter((id): id is string => typeof id === 'string' && id !== '').map((deviceId): MatterFallbackRecord => ({
                    deviceId, mode: 'fallback', reason: 'legacy-unknown', attempts: 0, pluginVersion: PLUGIN_VERSION_RAW,
                }));
            case 'foreign':
                // A newer (or unknown) format must survive a downgrade: state stays in memory only.
                this.readOnly = true;
                this.log.warn(
                    `[Matter] Fallback store ${this.filePath} has ${loaded.why}; it will not be modified. `
                    + 'Thermostat fallback state is kept in memory for this session.',
                );
                return [];
            case 'unreadable':
                this.keepUnreadableCopy(loaded.why);
                return [];
        }
    }

    /** A damaged file is set aside (once) before the store starts again from empty. */
    private keepUnreadableCopy(why: string): void {
        const backup = `${this.filePath}.unreadable.bak`;
        try {
            if (!fs.existsSync(backup)) fs.copyFileSync(this.filePath, backup);
            this.log.warn(`[Matter] Fallback store ${this.filePath} is unreadable (${why}); a copy is kept in ${backup} and the store starts empty.`);
        } catch (error: unknown) {
            this.readOnly = true;
            this.log.warn(`[Matter] Fallback store ${this.filePath} is unreadable (${why}) and could not be copied aside; it will not be modified: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private write(): void {
        if (this.readOnly) return;
        try {
            if (this.loadedLegacy && fs.existsSync(this.filePath)) {
                const backup = `${this.filePath}.v1.bak`;
                if (!fs.existsSync(backup)) fs.copyFileSync(this.filePath, backup);
                this.loadedLegacy = false;
            }
            const payload: StoreShapeV2 = {
                version: STORE_VERSION,
                thermostats: [...this.records.values()].sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
            };
            writeJsonAtomicSync(this.filePath, payload, 2);
        } catch (error: unknown) {
            this.log.warn(`[Matter] Could not write fallback store (${this.filePath}): ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** A v2 entry, or undefined when its required fields are not well-formed. Bad optional fields are dropped. */
function toRecord(value: unknown): MatterFallbackRecord | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const r = value as Partial<Record<keyof MatterFallbackRecord, unknown>>;
    if (typeof r.deviceId !== 'string' || !r.deviceId) return undefined;
    if (r.mode !== 'fallback' && r.mode !== 'retrying' && r.mode !== 'native') return undefined;
    if (typeof r.reason !== 'string' || !isCount(r.attempts) || typeof r.pluginVersion !== 'string') return undefined;
    return {
        deviceId: r.deviceId,
        mode: r.mode,
        reason: r.reason,
        attempts: r.attempts,
        ...(typeof r.lastFailureAt === 'string' ? { lastFailureAt: r.lastFailureAt } : {}),
        ...(isCount(r.lastProcessedRecoveryRequest) ? { lastProcessedRecoveryRequest: r.lastProcessedRecoveryRequest } : {}),
        ...(isCount(r.nativeShapeRevision) ? { nativeShapeRevision: r.nativeShapeRevision } : {}),
        pluginVersion: r.pluginVersion,
    };
}
