import { cite, ConfigIssues, hasOwn, isPlainObject, setOwn, typeName } from './config-values';

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

/** One validated name: the category and panel ID it applies to, and the ID as the user wrote it. */
export interface CustomNameRow {
    deviceId: string;
    category: keyof CustomNamesMap;
    id: string;
    name: string;
}

export interface ParsedCustomNames {
    /** The category map the platform looks names up in. */
    map: CustomNamesMap;
    /** Valid rows, in config order. */
    rows: CustomNameRow[];
    /** The user's config reduced to its valid entries, in the form it was written in. */
    cleaned: CustomNamesConfig | undefined;
}

const MAP_CATEGORIES: Array<keyof CustomNamesMap> = ['zones', 'outputs', 'sensors', 'scenarios'];

function isBlank(value: unknown): boolean {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function isPanelIdKey(category: keyof CustomNamesMap, id: string): boolean {
    return /^\d+$/.test(id) || (category === 'sensors' && isSystemSensorId(id));
}

function parseMapForm(configured: Record<string, unknown>, issues: ConfigIssues): ParsedCustomNames {
    const map = emptyMap();
    const rows: CustomNameRow[] = [];
    const cleaned: Partial<CustomNamesMap> = {};
    for (const key of Object.keys(configured)) {
        if (!MAP_CATEGORIES.some((category) => category === key)) {
            issues.warn('customNames', `unknown category ${cite(key)}; ignoring it`);
        }
    }
    for (const category of MAP_CATEGORIES) {
        const names = configured[category];
        if (names === undefined || names === null) continue;
        if (!isPlainObject(names)) {
            issues.warn(`customNames.${category}`, `expected an object, received ${typeName(names)}; ignoring it`);
            continue;
        }
        const kept: Record<string, string> = {};
        cleaned[category] = kept;
        for (const id of Object.keys(names)) {
            const value = names[id];
            const name = typeof value === 'string' ? value.trim() : '';
            if (!isPanelIdKey(category, id)) {
                issues.warn(`customNames.${category}`, `${cite(id)} is not a panel device ID; ignoring it`);
            } else if (!name) {
                issues.warn(`customNames.${category}`, `the name of ${cite(id)} must be a non-empty string, received ${typeName(value)}; ignoring it`);
            } else {
                setOwn(map[category], id, name);
                setOwn(kept, id, name);
                rows.push({ deviceId: isSystemSensorId(id) ? id : `${ENTRY_PREFIX[category]}${id}`, category, id, name });
            }
        }
    }
    return { map, rows, cleaned };
}

function parseArrayForm(configured: unknown[], issues: ConfigIssues): ParsedCustomNames {
    const map = emptyMap();
    const rows: CustomNameRow[] = [];
    configured.forEach((entry: unknown, index: number): void => {
        const where = `customNames[${index}]`;
        if (!isPlainObject(entry)) {
            issues.warn(where, `expected an object with deviceId and name, received ${typeName(entry)}; ignoring it`);
            return;
        }
        const deviceId = typeof entry.deviceId === 'string' ? entry.deviceId.trim() : '';
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        // The empty row the Homebridge UI leaves behind is not worth a warning.
        if (isBlank(entry.deviceId) && isBlank(entry.name)) return;
        if (!deviceId) {
            issues.warn(where, `deviceId must be a non-empty string, received ${typeName(entry.deviceId)}; ignoring the row`);
            return;
        }
        if (!name) {
            issues.warn(where, `the name of ${cite(deviceId)} must be a non-empty string, received ${typeName(entry.name)}; ignoring the row`);
            return;
        }
        for (const [pattern, category] of CATEGORY_BY_PREFIX) {
            const match = pattern.exec(deviceId);
            if (!match) continue;
            const previous = hasOwn(map[category], match[1]) ? map[category][match[1]] : undefined;
            if (previous !== undefined && previous !== name) {
                issues.warn(where, `${cite(deviceId)} is named more than once; the last name wins`);
            }
            setOwn(map[category], match[1], name);
            rows.push({ deviceId, category, id: match[1], name });
            return;
        }
        issues.warn(where, `${cite(deviceId)} is not a valid device ID (for example zone_3 or light_37); ignoring the row`);
    });
    const cleaned = rows.map((row): CustomNameEntry => ({ deviceId: row.deviceId, name: row.name }));
    return { map, rows, cleaned };
}

/**
 * Validates `customNames` in either accepted form, with the same rules for
 * both: a row or pair that is not a device ID with a non-empty string name is
 * dropped and reported, never thrown on (a malformed row must not stop the
 * platform from starting, nor poison the MQTT slugs derived from the name).
 */
export function parseCustomNames(configured: unknown, issues: ConfigIssues): ParsedCustomNames {
    if (configured === undefined || configured === null) return { map: emptyMap(), rows: [], cleaned: undefined };
    if (Array.isArray(configured)) return parseArrayForm(configured, issues);
    if (isPlainObject(configured)) return parseMapForm(configured, issues);
    issues.warn('customNames', `expected an array of { deviceId, name }, received ${typeName(configured)}; ignoring it`);
    return { map: emptyMap(), rows: [], cleaned: undefined };
}

/**
 * Always yields the category map. Quiet by default: the platform reports the
 * problems once at startup through `parseCustomNames`.
 */
export function normalizeCustomNames(
    configured: unknown,
    issues: ConfigIssues = new ConfigIssues(),
): CustomNamesMap {
    return parseCustomNames(configured, issues).map;
}

/** `category:id` of the name slot a device ID is looked up in, or undefined for an ID no name applies to. */
export function customNameSlot(deviceId: string): string | undefined {
    for (const [pattern, category] of CATEGORY_BY_PREFIX) {
        const match = pattern.exec(deviceId);
        if (match) return `${category}:${match[1]}`;
    }
    return undefined;
}

/** Lookup restricted to own properties: a panel ID such as `constructor` names nothing. */
export function lookupCustomName(names: Record<string, string>, id: string): string | undefined {
    return hasOwn(names, id) ? names[id] : undefined;
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
