import { cite, ConfigIssues, typeName } from './config-values';

/** The four `exclude*` config keys and the device-ID families each one accepts. */
export const EXCLUSION_LISTS = {
    excludeZones: { noun: 'zone', family: /^zone_(\d+)$/ },
    excludeOutputs: { noun: 'output', family: /^(?:light|cover|gate|thermostat|output)_(\d+)$/ },
    excludeSensors: { noun: 'sensor', family: /^sensor_(?:(?:temp|hum|light)_)?(\d+)$/ },
    excludeScenarios: { noun: 'scenario', family: /^scenario_(\d+)$/ },
} as const;

export type ExclusionKey = keyof typeof EXCLUSION_LISTS;

/** The panel's own temperature sensors have no numeric ID: they are listed by full ID. */
const SYSTEM_SENSOR_ID = /^sensor_system_temp_(?:in|out)$/;
const NUMERIC_ID = /^\d+$/;

/** `"05"` and `5` name the same panel ID; a leading zero must not hide a mismatch. */
function canonicalNumber(digits: string): string | undefined {
    const value = Number(digits);
    return Number.isSafeInteger(value) ? String(value) : undefined;
}

function toId(key: ExclusionKey, entry: unknown): string | undefined {
    let text: string;
    if (typeof entry === 'number') {
        if (!Number.isInteger(entry) || entry < 0) return undefined;
        text = String(entry);
    } else if (typeof entry === 'string') {
        text = entry.trim();
    } else {
        return undefined;
    }
    if (NUMERIC_ID.test(text)) return canonicalNumber(text);
    if (key === 'excludeSensors' && SYSTEM_SENSOR_ID.test(text)) return text;
    const match = EXCLUSION_LISTS[key].family.exec(text);
    return match ? canonicalNumber(match[1]) : undefined;
}

/**
 * Turns one `exclude*` value into the list of panel IDs compared by
 * `DiscoveryService` (exact match, after this normalization). Accepts numbers
 * (`5`), strings with spaces (`" 5"`) and full device IDs (`"gate_5"`); a value
 * that is not an array is an empty list, an entry that is not a device ID of
 * that kind is dropped. Both are reported, never thrown, and never turned into
 * a substring match.
 */
export function normalizeExclusionList(raw: unknown, key: ExclusionKey, issues: ConfigIssues): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        issues.warn(key, `expected an array of device IDs, received ${typeName(raw)}; nothing is excluded by it`);
        return [];
    }
    const ids = new Set<string>();
    for (const entry of raw) {
        const id = toId(key, entry);
        if (id === undefined) {
            issues.warn(key, `${cite(entry)} is not a ${EXCLUSION_LISTS[key].noun} ID; ignoring it`);
            continue;
        }
        ids.add(id);
    }
    return [...ids];
}

export function normalizeExclusionLists(
    raw: Partial<Record<ExclusionKey, unknown>>,
    issues: ConfigIssues,
): Record<ExclusionKey, string[]> {
    return {
        excludeZones: normalizeExclusionList(raw.excludeZones, 'excludeZones', issues),
        excludeOutputs: normalizeExclusionList(raw.excludeOutputs, 'excludeOutputs', issues),
        excludeSensors: normalizeExclusionList(raw.excludeSensors, 'excludeSensors', issues),
        excludeScenarios: normalizeExclusionList(raw.excludeScenarios, 'excludeScenarios', issues),
    };
}
