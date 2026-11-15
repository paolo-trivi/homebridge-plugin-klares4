import type { RoomConfig, RoomMappingConfig } from '../types';

/**
 * How the optional KSA import folds its derived settings into the user's
 * configuration. The rule throughout: the import adds what is missing and
 * never removes or overrides something the user configured.
 */

/** What the backup adds to a list of pairs, and where the user's own pair says something else. */
export interface PairMergePlan<T> {
    additions: T[];
    conflicts: Array<{ outputId: string; kept: string; backup: string }>;
}

function pairText(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** `18` and `thermostat_18` are the same thermostat output. */
function outputKey(value: unknown): string | undefined {
    return pairText(value)?.replace(/^thermostat_/, '');
}

/** The rows of a list as the user wrote it; anything that is not a list is no rows. */
export function existingRows(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

/**
 * Thermostat pairs from the backup are added only for outputs the user has no
 * pair for: the user's pairs always win and are never touched, replaced or
 * emptied (an empty backup adds nothing). `valueField` is the pair's second
 * field, compared to report where the user's pair differs from the backup.
 */
export function planPairMerge<T extends { thermostatOutputId: string }>(
    existing: unknown,
    derived: readonly T[],
    valueField: Exclude<keyof T & string, 'thermostatOutputId'>,
): PairMergePlan<T> {
    const userValueByOutput = new Map<string, string>();
    for (const row of existingRows(existing)) {
        if (typeof row !== 'object' || row === null) continue;
        const record = row as Record<string, unknown>;
        const output = outputKey(record.thermostatOutputId);
        if (output !== undefined && !userValueByOutput.has(output)) userValueByOutput.set(output, pairText(record[valueField]) ?? '');
    }
    const plan: PairMergePlan<T> = { additions: [], conflicts: [] };
    for (const pair of derived) {
        const output = outputKey(pair.thermostatOutputId) ?? pair.thermostatOutputId;
        const kept = userValueByOutput.get(output);
        if (kept === undefined) {
            plan.additions.push(pair);
        } else if (kept !== String(pair[valueField])) {
            plan.conflicts.push({ outputId: output, kept, backup: String(pair[valueField]) });
        }
    }
    return plan;
}

function hasNamedRoom(rooms: unknown): boolean {
    return Array.isArray(rooms) && rooms.some((room: unknown) => {
        const name = (room as Partial<RoomConfig> | null)?.roomName;
        return typeof name === 'string' && name.trim().length > 0;
    });
}

/**
 * The room mapping after a KSA import, or undefined when it must stay as it is.
 * Panel rooms are used only when the user has not defined any room (an empty
 * row left by the Homebridge UI does not count), and the user's `enabled`
 * flag is kept: the import never switches room mapping on, because that
 * changes every MQTT topic.
 */
export function resolveKsaRoomMapping(existing: unknown, ksaRooms: RoomConfig[]): RoomMappingConfig | undefined {
    const current = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
        ? existing as Partial<RoomMappingConfig>
        : undefined;
    if (ksaRooms.length === 0 || hasNamedRoom(current?.rooms)) return undefined;
    return { ...current, enabled: current?.enabled === true, rooms: ksaRooms };
}
