import type { KseniaOutputStatusRaw } from '../types';

/**
 * Predicates that say whether a STATUS_OUTPUTS entry shows the state a command
 * asked for. Panel fields are read defensively: a malformed entry is a
 * non-match, never an exception, and an empty or blank value is not a number.
 */

/** Upper-cased trimmed text, or undefined when the field is not a string. */
export function panelText(value: unknown): string | undefined {
    return typeof value === 'string' ? value.trim().toUpperCase() : undefined;
}

/** `"40"` and `40` are 40; `""`, `" "`, `null`, `"abc"` are not numbers (they used to read as 0). */
export function panelNumber(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function lightStateMatches(on: boolean): (status: KseniaOutputStatusRaw) => boolean {
    const target = on ? 'ON' : 'OFF';
    return (status) => panelText(status.STA) === target;
}

export function dimmerLevelMatches(level: number): (status: KseniaOutputStatusRaw) => boolean {
    return (status) => panelNumber(status.POS) === level
        || (level === 0 && panelText(status.STA) === 'OFF');
}

export function coverTargetMatches(position: number): (status: KseniaOutputStatusRaw) => boolean {
    return (status) => {
        const state = panelText(status.STA);
        const target = panelNumber(status.TPOS ?? status.POS);
        return target === position
            || (position === 100 && (state === 'UP' || state === 'OPEN'))
            || (position === 0 && (state === 'DOWN' || state === 'CLOSE'));
    };
}
