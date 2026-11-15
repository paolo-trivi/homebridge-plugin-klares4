import type { Logger } from 'homebridge';
import type { WebSocketClientState } from './types';

/**
 * What a refused read (`READ_RES` with a RESULT other than OK) means for the
 * synchronization that a login starts.
 * - `expected`: `PRG_THERMOSTATS` answered `CMD_NOT_AVAILABLE`, which the
 *   panel does at every login; nothing to report.
 * - `fatal`: a discovery read (`ZONES`, `MULTI_TYPES`). Without it the plugin
 *   does not know the devices, so the sync is not complete: the session is
 *   closed and retried with the reconnection backoff, up to
 *   `DISCOVERY_REFUSALS_BEFORE_DEGRADED` syncs in a row (see `ReadRefusals`).
 * - `degraded`: the status and thermostat reads. The REALTIME registration
 *   that ends the sync carries the initial status again, and thermostats fall
 *   back on their own sources, so the sync can still complete; the refusal
 *   is reported.
 */
export type ReadRefusalImpact = 'expected' | 'fatal' | 'degraded';

const DISCOVERY_READS = new Set(['ZONES', 'MULTI_TYPES']);

export function readRefusalImpact(payloadType: unknown, detail: string | undefined): ReadRefusalImpact {
    const type = typeof payloadType === 'string' ? payloadType.toUpperCase() : '';
    if (type === 'PRG_THERMOSTATS' && detail?.toUpperCase() === 'CMD_NOT_AVAILABLE') return 'expected';
    return DISCOVERY_READS.has(type) ? 'fatal' : 'degraded';
}

/** Device IDs owned by each section of the discovery reads. */
export const DISCOVERY_FAMILIES = {
    ZONES: (id: string): boolean => id.startsWith('zone_'),
    OUTPUTS: (id: string): boolean => /^(light|cover|gate|thermostat)_/.test(id),
    SCENARIOS: (id: string): boolean => id.startsWith('scenario_'),
    BUS_HAS: (id: string): boolean => /^sensor_(temp|hum|light)_/.test(id),
} as const;

export type DiscoverySection = keyof typeof DISCOVERY_FAMILIES;

/**
 * Syncs in a row in which the same discovery read may be refused before the
 * sync completes without it. A refusal now and then (panel busy) is retried
 * with a new session; a panel that always refuses one read (a user without
 * the right to read zones, a firmware without the command) must still serve
 * the families that answered, as 2.2.0 did.
 */
export const DISCOVERY_REFUSALS_BEFORE_DEGRADED = 3;

interface ReadRefusalsDeps {
    state: WebSocketClientState;
    log: Logger;
    /** Closes the session; the sync is not complete and is retried with the backoff. */
    abortSession: (reason: string) => void;
}

/** What to do with each refused read, counting the discovery refusals across sessions. */
export class ReadRefusals {
    constructor(private readonly deps: ReadRefusalsDeps) {}

    public refused(payloadType: unknown, result: string, detail: string | undefined): void {
        const what = `The panel refused the ${String(payloadType)} read (${detail ?? result})`;
        switch (readRefusalImpact(payloadType, detail)) {
            case 'expected':
                this.deps.log.debug(`${what}: not available on this panel`);
                return;
            case 'fatal':
                this.discoveryRefused(String(payloadType).toUpperCase(), what);
                return;
            default:
                this.deps.log.warn(`${what}; the synchronization continues without it`);
        }
    }

    /** A read answered OK: its refusal streak is over. */
    public accepted(payloadType: unknown): void {
        if (typeof payloadType === 'string') this.counts().delete(payloadType.toUpperCase());
    }

    private discoveryRefused(type: string, what: string): void {
        const count = (this.counts().get(type) ?? 0) + 1;
        this.counts().set(type, count);
        if (count < DISCOVERY_REFUSALS_BEFORE_DEGRADED) {
            this.deps.abortSession(`${what}: the synchronization is not complete, reconnecting`);
            return;
        }
        // Degraded sync: the devices of this read count as "did not answer",
        // which the prune discipline never removes.
        const message = `${what} in ${count} synchronizations in a row: continuing without it. `
            + `The devices it lists are not discovered or updated in this session (existing accessories are kept); `
            + 'check the permissions of the panel user configured in the plugin.';
        if (count === DISCOVERY_REFUSALS_BEFORE_DEGRADED || /^10*$/.test(String(count))) {
            this.deps.log.warn(message);
        } else {
            this.deps.log.debug(message);
        }
    }

    private counts(): Map<string, number> {
        this.deps.state.refusedDiscoveryReads ??= new Map();
        return this.deps.state.refusedDiscoveryReads;
    }
}
