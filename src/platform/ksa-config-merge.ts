/**
 * How the optional KSA import folds its derived settings into the user's
 * configuration. The rule throughout: the import adds what is missing and
 * never removes or overrides something the user configured.
 */

export const EXCLUSION_KEYS = {
    outputs: 'excludeOutputs',
    zones: 'excludeZones',
    sensors: 'excludeSensors',
    scenarios: 'excludeScenarios',
} as const;

/**
 * Union of the user's exclusion list and the suggested IDs, or undefined when
 * the suggestions add nothing (the list must then be left exactly as it is).
 */
export function mergeExclusionList(existing: unknown, suggested: readonly string[]): string[] | undefined {
    const current = Array.isArray(existing) ? existing.filter((id): id is string => typeof id === 'string') : [];
    const additions = suggested.filter((id) => !current.includes(id));
    if (additions.length === 0) return undefined;
    return [...new Set([...current, ...additions])];
}

/** Applies `mergeExclusionList` to every exclusion key of a config object, in place. */
export function applyExclusionSuggestions(
    target: Record<string, unknown>,
    suggestions: Record<keyof typeof EXCLUSION_KEYS, string[]>,
): void {
    for (const category of Object.keys(EXCLUSION_KEYS) as Array<keyof typeof EXCLUSION_KEYS>) {
        const key = EXCLUSION_KEYS[category];
        const merged = mergeExclusionList(target[key], suggestions[category]);
        if (merged) target[key] = merged;
    }
}
