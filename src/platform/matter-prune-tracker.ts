import type { API, Logger, MatterAccessory } from 'homebridge';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings';
import type { MatterRegistration } from './matter-registration-recovery';
import type { MatterFallbackStore } from './matter-fallback-store';
import type { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';

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

    constructor(private readonly log: Logger) {}

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
        this.missingCycleCounts.delete(uuid);
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
     * Ends with a compact topology-churn summary log line.
     */
    async runPruneCycle(deps: MatterPruneDeps): Promise<void> {
        let missingCandidates = 0;
        let pruneSkipped = 0;
        let unregisteredCount = 0;

        for (const [uuid, reg] of deps.registrations) {
            if (reg.status !== 'registered') continue;
            if (deps.activeDiscoveredUUIDs.has(uuid)) {
                this.recordSeen(uuid, reg.displayName);
                continue;
            }

            missingCandidates += 1;
            if (!this.recordMissing(uuid, reg.displayName)) {
                pruneSkipped += 1;
                continue;
            }

            try {
                await deps.api.matter!.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
                    { UUID: uuid } as MatterAccessory,
                ]);
                deps.registrations.delete(uuid);
                deps.cachedUUIDs.delete(uuid);
                deps.thermostatFallbackUUIDs.delete(uuid);
                deps.fallbackStore.remove(uuid);
                deps.thermostatEchoTracker.clear(uuid);
                this.clearMissing(uuid);
                unregisteredCount += 1;
            } catch (err) {
                this.log.warn(`[Matter] Failed to unregister ${uuid}: ${deps.fmtErr(err)}`);
            }
        }

        this.logCycleSummary(
            deps.activeDiscoveredUUIDs.size,
            deps.registrations.size,
            missingCandidates,
            pruneSkipped,
            unregisteredCount,
        );
    }
}
