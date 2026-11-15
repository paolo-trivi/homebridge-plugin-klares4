import type { Logger } from 'homebridge';
import { stripDevicePrefix } from '../device-id';
import { customNameSlot } from './custom-names-config';
import type { RuntimeConfig } from './runtime-config';

const MAX_SUGGESTIONS = 3;

/**
 * What the user most likely meant by a device ID that matches nothing: the
 * same ID in lower case, or, for a bare number (the form of the `exclude*`
 * lists), the discovered devices that carry it.
 */
function suggestionsFor(deviceId: string, discovered: ReadonlySet<string>): string[] {
    const lower = deviceId.toLowerCase();
    if (lower !== deviceId && discovered.has(lower)) return [lower];
    if (!/^\d+$/.test(deviceId)) return [];
    return [...discovered]
        .filter((id: string): boolean => stripDevicePrefix(id) === deviceId)
        .sort()
        .slice(0, MAX_SUGGESTIONS);
}

function describe(deviceId: string, discovered: ReadonlySet<string>): string {
    const suggestions = suggestionsFor(deviceId, discovered);
    const shown = JSON.stringify(deviceId.length > 40 ? `${deviceId.slice(0, 40)}...` : deviceId);
    return suggestions.length > 0 ? `${shown} (did you mean ${suggestions.join(' or ')}?)` : shown;
}

/**
 * Called once, when the first full sync has discovered the devices. Reports
 * the per-device config that has no effect because it names no discovered
 * device (a wrong ID form is an easy mistake: `zone_1`, not `1`, not `ZONE_1`),
 * and the devices `matterOverrides` hides from Matter. Only devices that were
 * really discovered count as hidden.
 */
export function reportConfigOverrides(
    runtime: RuntimeConfig,
    discoveredIds: ReadonlySet<string>,
    log: Logger,
): void {
    const hidden = Object.keys(runtime.matterOverrides)
        .filter((id: string): boolean => discoveredIds.has(id) && runtime.matterOverrides[id].exposed === false);
    if (hidden.length > 0) {
        // A Homebridge UI save before 2.2.0 wrote exposed:false on every override row.
        log.warn(
            `[Matter] matterOverrides hides ${hidden.length} device(s) from Matter: ${hidden.join(', ')}. `
            + 'If you did not untick "Exposed on Matter" yourself, tick it again in the plugin settings.',
        );
    }

    const slots = new Set<string>();
    for (const id of discoveredIds) {
        const slot = customNameSlot(id);
        if (slot) slots.add(slot);
    }
    const unmatched: Array<[string, string[]]> = [
        ['matterOverrides', Object.keys(runtime.matterOverrides).filter((id) => !discoveredIds.has(id))],
        ['matterRecoveryRequests', Object.keys(runtime.matterRecoveryRequests).filter((id) => !discoveredIds.has(id))],
        ['customNames', runtime.customNameRows
            .filter((row) => !slots.has(`${row.category}:${row.id}`))
            .map((row) => row.deviceId)],
    ];
    const lines = unmatched
        .filter(([, ids]) => ids.length > 0)
        .map(([key, ids]) => `  - ${key}: ${ids.map((id) => describe(id, discoveredIds)).join(', ')}`);
    if (lines.length === 0) return;
    log.warn(
        'Configuration: these entries match no device discovered on the panel and have no effect '
        + `(device IDs look like zone_1, light_5, scenario_2):\n${lines.join('\n')}`,
    );
}
