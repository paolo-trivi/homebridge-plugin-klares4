/**
 * `customNames` in either accepted form.
 *
 * Legacy map form, keyed by category then by the panel's numeric ID:
 * `{ "outputs": { "37": "PC Studio" }, "zones": { "3": "Finestra" } }`.
 *
 * Array form, one typed row per device:
 * `[{ "deviceId": "light_37", "name": "PC Studio" }]`.
 *
 * The Homebridge UI rebuilds `config.json` from its form model and silently
 * drops object-typed keys it cannot render. The map form is exactly that shape,
 * so saving any unrelated setting from the UI deleted every custom name (and
 * with them the MQTT topics and Matter names derived from them). The array form
 * renders and round-trips; the map form stays accepted.
 */
export interface CustomNamesMap {
    zones: Record<string, string>;
    outputs: Record<string, string>;
    sensors: Record<string, string>;
    scenarios: Record<string, string>;
}

export interface CustomNameEntry {
    deviceId?: string;
    name?: string;
}

export type CustomNamesConfig = Partial<CustomNamesMap> | CustomNameEntry[];

/**
 * Output-like devices share one namespace on the panel, so every output family
 * (and the generic `output_` form written by the KSA import) maps to `outputs`.
 * A DOMUS sensor name is its base name, applied to all three of its readings.
 * The panel's own temperature sensors have no numeric ID: they are keyed by
 * their full device ID (the same value the exclusion list compares).
 */
const CATEGORY_BY_PREFIX: Array<[RegExp, keyof CustomNamesMap]> = [
    [/^zone_(\d+)$/, 'zones'],
    [/^(?:light|cover|gate|thermostat|output)_(\d+)$/, 'outputs'],
    [/^sensor_(?:(?:temp|hum|light)_)?(\d+)$/, 'sensors'],
    [/^(sensor_system_temp_(?:in|out))$/, 'sensors'],
    [/^scenario_(\d+)$/, 'scenarios'],
];

function emptyMap(): CustomNamesMap {
    return { zones: {}, outputs: {}, sensors: {}, scenarios: {} };
}

/**
 * Always yields the category map. Rows without a usable device ID or name are
 * dropped rather than throwing: a malformed row in the UI must not stop the
 * platform from starting.
 */
export function normalizeCustomNames(configured: CustomNamesConfig | undefined): CustomNamesMap {
    const normalized = emptyMap();
    if (!configured) return normalized;
    if (!Array.isArray(configured)) {
        for (const category of Object.keys(normalized) as Array<keyof CustomNamesMap>) {
            normalized[category] = { ...(configured[category] ?? {}) };
        }
        return normalized;
    }

    for (const entry of configured) {
        const deviceId = typeof entry?.deviceId === 'string' ? entry.deviceId.trim() : '';
        const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
        if (!deviceId || !name) continue;
        for (const [pattern, category] of CATEGORY_BY_PREFIX) {
            const match = pattern.exec(deviceId);
            if (match) {
                normalized[category][match[1]] = name;
                break;
            }
        }
    }
    return normalized;
}

const ENTRY_PREFIX: Record<keyof CustomNamesMap, string> = {
    zones: 'zone_',
    outputs: 'output_',
    sensors: 'sensor_',
    scenarios: 'scenario_',
};

/**
 * Adds imported names to the user's `customNames` without overriding any of
 * them: a device the user already named keeps that name. The user's rows are
 * kept verbatim (a legacy map is converted to rows); imported names follow
 * as new rows. Always the array form, the one the Homebridge UI preserves.
 */
export function mergeCustomNames(
    configured: CustomNamesConfig | undefined,
    imported: Partial<CustomNamesMap>,
): CustomNameEntry[] {
    const userNames = normalizeCustomNames(configured);
    const rows: CustomNameEntry[] = Array.isArray(configured)
        ? configured.map((entry) => ({ ...entry }))
        : toCustomNameEntries(userNames);
    const additions: Partial<CustomNamesMap> = {};
    for (const category of Object.keys(ENTRY_PREFIX) as Array<keyof CustomNamesMap>) {
        const missing: Record<string, string> = {};
        for (const [id, name] of Object.entries(imported[category] ?? {})) {
            if (!Object.prototype.hasOwnProperty.call(userNames[category], id)) missing[id] = name;
        }
        additions[category] = missing;
    }
    return [...rows, ...toCustomNameEntries(additions)];
}

export function isSystemSensorId(id: string): boolean {
    return id === 'sensor_system_temp_in' || id === 'sensor_system_temp_out';
}

/** Array form of a category map, as written back to `config.json` (KSA import). */
export function toCustomNameEntries(names: Partial<CustomNamesMap>): CustomNameEntry[] {
    const entries: CustomNameEntry[] = [];
    for (const category of Object.keys(ENTRY_PREFIX) as Array<keyof CustomNamesMap>) {
        for (const [id, name] of Object.entries(names[category] ?? {})) {
            const deviceId = isSystemSensorId(id) ? id : `${ENTRY_PREFIX[category]}${id}`;
            entries.push({ deviceId, name });
        }
    }
    return entries;
}
