/**
 * What a refused read (`READ_RES` with a RESULT other than OK) means for the
 * synchronization that a login starts.
 * - `expected`: `PRG_THERMOSTATS` answered `CMD_NOT_AVAILABLE`, which the
 *   panel does at every login; nothing to report.
 * - `fatal`: a discovery read (`ZONES`, `MULTI_TYPES`). Without it the plugin
 *   does not know the devices, so the sync is not complete: the session is
 *   closed and retried with the reconnection backoff.
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
