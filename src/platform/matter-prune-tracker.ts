import type { API, Logger } from 'homebridge';
import type { KseniaDevice } from '../types';
import type { MatterRegistration } from './matter-registration-recovery';
import type { MatterFallbackStore } from './matter-fallback-store';
import { MatterPruneCounters } from './matter-prune-counters';
import type { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';
import { registrationProbeCluster, type MatterTopologyCoordinator } from './matter-topology-coordinator';
import {
    PRUNE_MIN_DISCOVERY_RATIO, PRUNE_STALE_THRESHOLD_CYCLES, belowDiscoveryFloor, discoveryFamily, familiesOf,
} from './prune-policy';

/**
 * Minimum number of consecutive discovery cycles an accessory must be absent
 * from before it is treated as genuinely stale and unregistered (see
 * `prune-policy.ts`, shared with HAP).
 */
export const MATTER_PRUNE_STALE_THRESHOLD_CYCLES = PRUNE_STALE_THRESHOLD_CYCLES;

interface MatterCycleStats {
    newlyRegistered: number;
    cachedRestore: number;
    metadataChanged: number;
    metadataUnchanged: number;
}

function emptyStats(): MatterCycleStats {
    return { newlyRegistered: 0, cachedRestore: 0, metadataChanged: 0, metadataUnchanged: 0 };
}

interface PruneCounters {
    missingCandidates: number;
    pruneSkipped: number;
    unregisteredCount: number;
    familyNotAnswered: number;
}

export interface MatterPruneDeps {
    api: API;
    topologyCoordinator: MatterTopologyCoordinator;
    registrations: Map<string, MatterRegistration>;
    activeDiscoveredUUIDs: Set<string>;
    cachedUUIDs: Set<string>;
    /** Cached accessory device snapshots (uuid → device), from configureMatterAccessory. */
    cachedDevices?: Map<string, KseniaDevice>;
    /** Matter-side eligibility (exclusions + matterExposure + policy); undefined = everything exposed. */
    isDeviceExposed?: (device: KseniaDevice) => boolean;
    /**
     * Families that listed at least one device in this sync, whatever its
     * Matter exposure. Without it, the families of the endpoints seen in this cycle.
     */
    answeredFamilies?: ReadonlySet<string>;
    thermostatFallbackUUIDs: Set<string>;
    fallbackStore: MatterFallbackStore;
    thermostatEchoTracker: MatterThermostatEchoTracker;
    fmtErr: (err: unknown) => string;
}

/** One endpoint of the plugin on the bridge, as the prune judges it. */
interface PruneSubject {
    uuid: string;
    displayName: string;
    device?: KseniaDevice;
    registration?: MatterRegistration;
}

/**
 * Tracks, per Matter accessory UUID, how many consecutive discovery cycles it
 * has been missing from, plus per-cycle registration/metadata counters — so
 * `MatterAccessoryRegistry.pruneStaleAccessories` can log a compact topology
 * summary and only unregister after `MATTER_PRUNE_STALE_THRESHOLD_CYCLES`
 * consecutive misses instead of on the very first one.
 */
export class MatterPruneTracker {
    private readonly counters: MatterPruneCounters;
    private cycleNumber = 0;
    private stats: MatterCycleStats = emptyStats();

    constructor(private readonly log: Logger, storagePath?: string) {
        this.counters = new MatterPruneCounters(log, storagePath);
    }

    /** Resets per-cycle counters. The prune pass advances the cycle number. */
    startCycle(): void {
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
        if (this.counters.delete(uuid)) {
            this.log.debug(`[Matter] Missing-cycle counter reset for ${displayName} (${uuid}) — device reappeared`);
        }
    }

    /**
     * Device absent from the current cycle. Returns whether it has now
     * crossed the stale threshold and should really be unregistered.
     */
    recordMissing(uuid: string, displayName: string): boolean {
        const missedCycles = this.counters.get(uuid) + 1;
        this.counters.set(uuid, missedCycles);

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
        this.counters.delete(uuid);
    }

    /**
     * One prune pass, with the discipline of `prune-policy.ts`, over every
     * endpoint the plugin holds on the bridge: the ones registered in this
     * session and the ones Homebridge restored from its cache and nobody
     * registered since (a device deleted on the panel is only ever the latter
     * after a restart).
     *
     *  - seen in this cycle: its counter is cleared;
     *  - hidden by config or policy: counts as missing whatever the panel reported;
     *  - otherwise it counts as missing only when the sync is above the
     *    discovery floor and its family answered.
     *
     * Ends with a compact topology-churn summary log line.
     */
    async runPruneCycle(deps: MatterPruneDeps): Promise<void> {
        this.cycleNumber += 1;
        const counters: PruneCounters = { missingCandidates: 0, pruneSkipped: 0, unregisteredCount: 0, familyNotAnswered: 0 };
        const subjects = this.subjects(deps);
        const exposed = (s: PruneSubject): boolean => !s.device || !deps.isDeviceExposed || deps.isDeviceExposed(s.device);
        const known = subjects.filter(exposed).length;
        const discovered = deps.activeDiscoveredUUIDs.size;
        const partialSync = belowDiscoveryFloor(discovered, known);
        if (partialSync) {
            this.log.warn(
                `[Matter] Prune: discovery returned ${discovered} of ${known} exposed endpoint(s), below the `
                + `${Math.round(PRUNE_MIN_DISCOVERY_RATIO * 100)}% safety floor; no endpoint counts as missing in this sync`,
            );
        }
        const answered = deps.answeredFamilies ?? familiesOf(deps.activeDiscoveredUUIDs);

        for (const subject of subjects) {
            if (deps.activeDiscoveredUUIDs.has(subject.uuid)) {
                this.recordSeen(subject.uuid, subject.displayName);
                continue;
            }
            if (exposed(subject)) {
                // Without a cached device snapshot the family is unknown: keep it.
                if (partialSync || !subject.device) continue;
                if (!answered.has(discoveryFamily(subject.uuid))) {
                    counters.familyNotAnswered += 1;
                    continue;
                }
            }
            await this.pruneCandidate(subject, deps, counters);
        }

        const orphans = this.counters.retainOnly((uuid) => deps.registrations.has(uuid) || deps.cachedUUIDs.has(uuid));
        if (orphans.length > 0) this.log.debug(`[Matter] Dropped prune counters of endpoints no longer held: ${orphans.join(', ')}`);
        this.saveCountersIfDirty();
        this.logCycleSummary(discovered, deps.registrations.size, counters);
        this.stats = emptyStats();
    }

    /** Registered endpoints, then cache-restored endpoints with no registration in this session. */
    private subjects(deps: MatterPruneDeps): PruneSubject[] {
        const subjects: PruneSubject[] = [];
        for (const [uuid, registration] of deps.registrations) {
            if (registration.status !== 'registered') continue;
            const device = registration.matterAccessory.context?.device as KseniaDevice | undefined;
            subjects.push({ uuid, displayName: registration.displayName, device, registration });
        }
        for (const uuid of deps.cachedUUIDs) {
            if (deps.registrations.has(uuid)) continue;
            const device = deps.cachedDevices?.get(uuid);
            subjects.push({ uuid, displayName: device?.name ?? uuid, device });
        }
        return subjects;
    }

    private saveCountersIfDirty(): void {
        this.counters.saveIfDirty();
    }

    private logCycleSummary(discovered: number, registered: number, counters: PruneCounters): void {
        this.log.info(
            `[Matter] cycle #${this.cycleNumber}${this.isBootstrapCycle ? ' (bootstrap)' : ''}: `
            + `discovered=${discovered} registered=${registered} `
            + `newlyRegistered=${this.stats.newlyRegistered} cachedRestore=${this.stats.cachedRestore} `
            + `metadataChanged=${this.stats.metadataChanged} metadataUnchanged=${this.stats.metadataUnchanged} `
            + `missingCandidates=${counters.missingCandidates} pruneSkipped=${counters.pruneSkipped} `
            + `keptFamilyNotAnswered=${counters.familyNotAnswered} unregistered=${counters.unregisteredCount}`,
        );
    }

    private async pruneCandidate(subject: PruneSubject, deps: MatterPruneDeps, counters: PruneCounters): Promise<void> {
        const { uuid } = subject;
        counters.missingCandidates += 1;
        if (!this.recordMissing(uuid, subject.displayName)) {
            counters.pruneSkipped += 1;
            return;
        }

        try {
            const probeCluster = subject.registration
                ? registrationProbeCluster(subject.registration.matterAccessory)
                : 'bridgedDeviceBasicInformation';
            const removed = await deps.topologyCoordinator.unregister(uuid, probeCluster);
            if (!removed) return;
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
