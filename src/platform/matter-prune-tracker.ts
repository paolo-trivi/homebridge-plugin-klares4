import * as fs from 'fs';
import * as path from 'path';
import type { API, Logger, MatterAccessory } from 'homebridge';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings';
import type { KseniaDevice } from '../types';
import type { MatterRegistration } from './matter-registration-recovery';
import type { MatterFallbackStore } from './matter-fallback-store';
import type { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';

const COUNTER_STORE_FILENAME = 'klares4-matter-prune.json';

interface CounterStoreShape {
    version: 1;
    missing: Record<string, number>;
}

/**
 * Minimum number of consecutive discovery cycles an accessory must be absent
 * from before it is treated as genuinely stale and unregistered. A single
 * incomplete/disturbed discovery cycle (WS reconnect mid-sync, slow Klares4
 * response) must never by itself be enough to remove a Matter accessory —
 * see the "P0 — Prune aggressivo" stabilization work in ARCHITECTURE.md.
 */
export const MATTER_PRUNE_STALE_THRESHOLD_CYCLES = 3;

interface MatterCycleStats {
    newlyRegistered: number;
    cachedRestore: number;
    metadataChanged: number;
    metadataUnchanged: number;
}

function emptyStats(): MatterCycleStats {
    return { newlyRegistered: 0, cachedRestore: 0, metadataChanged: 0, metadataUnchanged: 0 };
}

export interface MatterPruneDeps {
    api: API;
    registrations: Map<string, MatterRegistration>;
    activeDiscoveredUUIDs: Set<string>;
    cachedUUIDs: Set<string>;
    /** Cached accessory device snapshots (uuid → device), from configureMatterAccessory. */
    cachedDevices?: Map<string, KseniaDevice>;
    /** Matter-side eligibility (exclusions + matterExposure); undefined = everything exposed. */
    isDeviceExposed?: (device: KseniaDevice) => boolean;
    thermostatFallbackUUIDs: Set<string>;
    fallbackStore: MatterFallbackStore;
    thermostatEchoTracker: MatterThermostatEchoTracker;
    fmtErr: (err: unknown) => string;
}

/**
 * Tracks, per Matter accessory UUID, how many consecutive discovery cycles it
 * has been missing from, plus per-cycle registration/metadata counters — so
 * `MatterAccessoryRegistry.pruneStaleAccessories` can log a compact topology
 * summary and only unregister after `MATTER_PRUNE_STALE_THRESHOLD_CYCLES`
 * consecutive misses instead of on the very first one.
 */
export class MatterPruneTracker {
    private readonly missingCycleCounts = new Map<string, number>();
    private cycleNumber = 0;
    private stats: MatterCycleStats = emptyStats();
    private readonly counterFilePath?: string;
    private countersDirty = false;

    /**
     * When `storagePath` is provided the missing-cycle counters persist across
     * restarts (`klares4-matter-prune.json`). Without persistence a stable
     * setup runs exactly ONE prune cycle per boot, the in-memory counter
     * restarts from zero every time and the 3-consecutive-cycles threshold is
     * never crossed — so a genuinely stale endpoint (device removed from the
     * panel, type disabled via `matterExposure`) would survive forever.
     */
    constructor(private readonly log: Logger, storagePath?: string) {
        if (storagePath) {
            this.counterFilePath = path.join(storagePath, COUNTER_STORE_FILENAME);
            this.loadCounters();
        }
    }

    private loadCounters(): void {
        if (!this.counterFilePath) return;
        try {
            if (!fs.existsSync(this.counterFilePath)) return;
            const parsed = JSON.parse(fs.readFileSync(this.counterFilePath, 'utf8')) as Partial<CounterStoreShape>;
            if (!parsed.missing || typeof parsed.missing !== 'object') return;
            for (const [uuid, count] of Object.entries(parsed.missing)) {
                if (typeof count === 'number' && Number.isInteger(count) && count > 0) {
                    this.missingCycleCounts.set(uuid, count);
                }
            }
        } catch (err) {
            this.log.warn(`[Matter] Could not load prune-counter store (${this.counterFilePath}): ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private saveCountersIfDirty(): void {
        if (!this.counterFilePath || !this.countersDirty) return;
        this.countersDirty = false;
        try {
            const payload: CounterStoreShape = {
                version: 1,
                missing: Object.fromEntries([...this.missingCycleCounts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
            };
            fs.writeFileSync(this.counterFilePath, JSON.stringify(payload, null, 2), 'utf8');
        } catch (err) {
            this.log.warn(`[Matter] Could not write prune-counter store (${this.counterFilePath}): ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /** Marks the start of a new discovery cycle and resets per-cycle counters. */
    startCycle(): void {
        this.cycleNumber += 1;
        this.stats = emptyStats();
    }

    get isBootstrapCycle(): boolean {
        return this.cycleNumber <= 1;
    }

    recordNewlyRegistered(): void {
        this.stats.newlyRegistered += 1;
    }

    recordCachedRestore(): void {
        this.stats.cachedRestore += 1;
    }

    recordMetadataChanged(): void {
        this.stats.metadataChanged += 1;
    }

    recordMetadataUnchanged(): void {
        this.stats.metadataUnchanged += 1;
    }

    /** Device seen in the current cycle: clears its missing-cycle counter, if any. */
    recordSeen(uuid: string, displayName: string): void {
        if (this.missingCycleCounts.delete(uuid)) {
            this.countersDirty = true;
            this.log.debug(`[Matter] Missing-cycle counter reset for ${displayName} (${uuid}) — device reappeared`);
        }
    }

    /**
     * Device absent from the current cycle. Returns whether it has now
     * crossed the stale threshold and should really be unregistered.
     */
    recordMissing(uuid: string, displayName: string): boolean {
        const missedCycles = (this.missingCycleCounts.get(uuid) ?? 0) + 1;
        this.missingCycleCounts.set(uuid, missedCycles);
        this.countersDirty = true;

        if (missedCycles < MATTER_PRUNE_STALE_THRESHOLD_CYCLES) {
            this.log.info(
                `[Matter] Missing candidate: ${displayName} (${uuid}) — absent for `
                + `${missedCycles}/${MATTER_PRUNE_STALE_THRESHOLD_CYCLES} cycles`
                + `${this.isBootstrapCycle ? ' [bootstrap cycle]' : ''}, unregister skipped`,
            );
            return false;
        }

        this.log.info(
            `[Matter] Removing stale accessory: ${displayName} (${uuid}) — absent for ${missedCycles} consecutive cycles`,
        );
        return true;
    }

    /** Clears the missing-cycle counter after a real unregister. */
    clearMissing(uuid: string): void {
        if (this.missingCycleCounts.delete(uuid)) {
            this.countersDirty = true;
        }
    }

    logCycleSummary(discovered: number, registered: number, missingCandidates: number, pruneSkipped: number, unregistered: number): void {
        this.log.info(
            `[Matter] cycle #${this.cycleNumber}${this.isBootstrapCycle ? ' (bootstrap)' : ''}: `
            + `discovered=${discovered} registered=${registered} `
            + `newlyRegistered=${this.stats.newlyRegistered} cachedRestore=${this.stats.cachedRestore} `
            + `metadataChanged=${this.stats.metadataChanged} metadataUnchanged=${this.stats.metadataUnchanged} `
            + `missingCandidates=${missingCandidates} pruneSkipped=${pruneSkipped} unregistered=${unregistered}`,
        );
    }

    /**
     * Runs one prune pass over `deps.registrations`: accessories absent from
     * `activeDiscoveredUUIDs` are only unregistered once they've crossed
     * `MATTER_PRUNE_STALE_THRESHOLD_CYCLES` consecutive misses (see class doc).
     *
     * A second pass covers *cached-only* endpoints (registered in a previous
     * session, never re-registered in this one) whose device type has since
     * been disabled via `matterExposure`: they follow the same
     * missing-cycles discipline before being unregistered for good.
     *
     * Ends with a compact topology-churn summary log line.
     */
    async runPruneCycle(deps: MatterPruneDeps): Promise<void> {
        const counters = { missingCandidates: 0, pruneSkipped: 0, unregisteredCount: 0 };

        for (const [uuid, reg] of deps.registrations) {
            if (reg.status !== 'registered') continue;
            if (deps.activeDiscoveredUUIDs.has(uuid)) {
                this.recordSeen(uuid, reg.displayName);
                continue;
            }
            await this.pruneCandidate(uuid, reg.displayName, deps, counters);
        }

        // Cached-only endpoints of exposure-disabled types (config changed
        // between sessions). Only config-driven absences are handled here —
        // cached devices that are merely missing from discovery keep the
        // conservative "wait for a registration to go stale" behaviour.
        if (deps.cachedDevices && deps.isDeviceExposed) {
            for (const [uuid, device] of deps.cachedDevices) {
                if (deps.registrations.has(uuid)) continue;
                if (deps.isDeviceExposed(device)) continue;
                await this.pruneCandidate(uuid, device.name, deps, counters);
            }
        }

        this.saveCountersIfDirty();

        this.logCycleSummary(
            deps.activeDiscoveredUUIDs.size,
            deps.registrations.size,
            counters.missingCandidates,
            counters.pruneSkipped,
            counters.unregisteredCount,
        );
    }

    private async pruneCandidate(
        uuid: string,
        displayName: string,
        deps: MatterPruneDeps,
        counters: { missingCandidates: number; pruneSkipped: number; unregisteredCount: number },
    ): Promise<void> {
        counters.missingCandidates += 1;
        if (!this.recordMissing(uuid, displayName)) {
            counters.pruneSkipped += 1;
            return;
        }

        try {
            await deps.api.matter!.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
                { UUID: uuid } as MatterAccessory,
            ]);
            deps.registrations.delete(uuid);
            deps.cachedUUIDs.delete(uuid);
            deps.cachedDevices?.delete(uuid);
            deps.thermostatFallbackUUIDs.delete(uuid);
            deps.fallbackStore.remove(uuid);
            deps.thermostatEchoTracker.clear(uuid);
            this.clearMissing(uuid);
            counters.unregisteredCount += 1;
        } catch (err) {
            this.log.warn(`[Matter] Failed to unregister ${uuid}: ${deps.fmtErr(err)}`);
        }
    }
}
