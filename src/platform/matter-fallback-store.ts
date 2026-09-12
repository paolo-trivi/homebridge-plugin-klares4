import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';
import { PLUGIN_VERSION_RAW } from '../plugin-version';

const STORE_FILENAME = 'klares4-matter-fallback.json';
const STORE_VERSION = 2;

export interface MatterFallbackRecord {
    deviceId: string;
    mode: 'fallback' | 'retrying' | 'native';
    reason: string;
    attempts: number;
    lastFailureAt?: string;
    lastProcessedRecoveryRequest?: number;
    pluginVersion: string;
}

interface LegacyStoreShape {
    thermostatAsTemperatureSensor?: unknown[];
}

interface StoreShapeV2 {
    version: 2;
    thermostats: MatterFallbackRecord[];
}

export class MatterFallbackStore {
    private readonly filePath: string;
    private readonly records = new Map<string, MatterFallbackRecord>();
    private loaded = false;
    private loadedLegacy = false;

    constructor(storagePath: string, private readonly log: Logger) {
        this.filePath = path.join(storagePath, STORE_FILENAME);
    }

    public load(): Set<string> {
        if (!this.loaded) this.loadRecords();
        const fallbackIds = new Set<string>();
        for (const record of this.records.values()) {
            if (record.mode === 'retrying') {
                record.mode = 'fallback';
                record.reason = 'interrupted-recovery';
                record.lastFailureAt = new Date().toISOString();
                this.write();
            }
            if (record.mode === 'fallback') fallbackIds.add(record.deviceId);
        }
        return fallbackIds;
    }

    public beginRecovery(deviceId: string, request: number): boolean {
        this.load();
        const record = this.records.get(deviceId);
        if (!record || record.mode !== 'fallback') return false;
        if (!Number.isInteger(request) || request <= 0) return false;
        if ((record.lastProcessedRecoveryRequest ?? 0) >= request) return false;
        record.mode = 'retrying';
        record.attempts += 1;
        record.lastProcessedRecoveryRequest = request;
        record.pluginVersion = PLUGIN_VERSION_RAW;
        this.write();
        return true;
    }

    public add(deviceId: string, reason = 'registration-failure'): void {
        this.load();
        const existing = this.records.get(deviceId);
        this.records.set(deviceId, {
            deviceId,
            mode: 'fallback',
            reason,
            attempts: existing?.attempts ?? 0,
            lastFailureAt: new Date().toISOString(),
            lastProcessedRecoveryRequest: existing?.lastProcessedRecoveryRequest,
            pluginVersion: PLUGIN_VERSION_RAW,
        });
        this.write();
    }

    public markNative(deviceId: string): void {
        this.load();
        const existing = this.records.get(deviceId);
        if (!existing) return;
        this.records.set(deviceId, { ...existing, mode: 'native', reason: 'recovered' });
        this.write();
    }

    public remove(deviceId: string): void {
        this.load();
        if (!this.records.delete(deviceId)) return;
        this.write();
    }

    public has(deviceId: string): boolean {
        this.load();
        return this.records.get(deviceId)?.mode === 'fallback';
    }

    public getRecord(deviceId: string): MatterFallbackRecord | undefined {
        this.load();
        const record = this.records.get(deviceId);
        return record ? { ...record } : undefined;
    }

    private loadRecords(): void {
        this.loaded = true;
        try {
            if (!fs.existsSync(this.filePath)) return;
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as LegacyStoreShape | StoreShapeV2;
            if ('version' in parsed && parsed.version === STORE_VERSION && Array.isArray(parsed.thermostats)) {
                for (const value of parsed.thermostats) {
                    if (this.isValidRecord(value)) this.records.set(value.deviceId, { ...value });
                }
                return;
            }
            this.loadedLegacy = true;
            const legacyStore = parsed as LegacyStoreShape;
            const legacy = Array.isArray(legacyStore.thermostatAsTemperatureSensor)
                ? legacyStore.thermostatAsTemperatureSensor
                : [];
            for (const value of legacy) {
                if (typeof value !== 'string' || !value) continue;
                this.records.set(value, {
                    deviceId: value,
                    mode: 'fallback',
                    reason: 'legacy-unknown',
                    attempts: 0,
                    pluginVersion: PLUGIN_VERSION_RAW,
                });
            }
        } catch (error: unknown) {
            this.log.warn(`[Matter] Could not load fallback store (${this.filePath}): ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private isValidRecord(value: unknown): value is MatterFallbackRecord {
        if (!value || typeof value !== 'object') return false;
        const record = value as Partial<MatterFallbackRecord>;
        return typeof record.deviceId === 'string' && !!record.deviceId
            && (record.mode === 'fallback' || record.mode === 'retrying' || record.mode === 'native')
            && typeof record.reason === 'string'
            && Number.isInteger(record.attempts) && (record.attempts ?? -1) >= 0
            && typeof record.pluginVersion === 'string';
    }

    private write(): void {
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
            const temporaryPath = `${this.filePath}.tmp`;
            fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), 'utf8');
            fs.renameSync(temporaryPath, this.filePath);
        } catch (error: unknown) {
            this.log.warn(`[Matter] Could not write fallback store (${this.filePath}): ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
