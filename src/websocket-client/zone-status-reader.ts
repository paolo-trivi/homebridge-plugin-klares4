import type { Logger } from 'homebridge';
import type { KseniaZoneStatusRaw, ZoneStatus } from '../types';

type ZoneFlag = 'open' | 'bypassed' | 'armed' | 'fault' | 'tampered';

/**
 * How each STATUS_ZONES field maps to a flag. Real captures only show the
 * resting values (`STA` R/A, `BYP` NO, `A` N, `FM` F, `T` N), so:
 * - `STA`, `FM`: both values are known; anything else is not interpreted.
 * - `BYP`, `T`: `NO`/`N` is the only "off" value seen. Any other non-empty
 *   value is read as on (bypassed, tampered): an unknown code surfaces as
 *   a visible state instead of hiding a bypassed or tampered zone.
 * - `A`: only `N` was ever seen, even for zones in alarm, so its meaning is
 *   not established. `Y` keeps the meaning it had (`armed`); any other
 *   value is not interpreted.
 * A field that is absent, or a value that is not interpreted, leaves the
 * flag as it was.
 */
const FIELD_RULES: ReadonlyArray<{
    field: keyof KseniaZoneStatusRaw;
    flag: ZoneFlag;
    read: (value: string) => boolean | undefined;
}> = [
    { field: 'STA', flag: 'open', read: (v) => (v === 'A' ? true : v === 'R' ? false : undefined) },
    { field: 'BYP', flag: 'bypassed', read: (v) => v !== 'NO' },
    { field: 'A', flag: 'armed', read: (v) => (v === 'Y' ? true : v === 'N' ? false : undefined) },
    { field: 'FM', flag: 'fault', read: (v) => (v === 'T' ? true : v === 'F' ? false : undefined) },
    { field: 'T', flag: 'tampered', read: (v) => v !== 'N' },
];

const KNOWN_VALUES: Readonly<Record<string, readonly string[]>> = {
    STA: ['A', 'R'], BYP: ['NO'], A: ['N', 'Y'], FM: ['F', 'T'], T: ['N'],
};

export class ZoneFieldReader {
    /** `field=value` pairs never seen in a capture, logged once each. */
    private readonly reportedValues = new Set<string>();

    constructor(private readonly log: Logger) {}

    /** Applies the fields present in `raw`; true when at least one was read. */
    public apply(status: ZoneStatus, raw: KseniaZoneStatusRaw): boolean {
        let read = false;
        for (const rule of FIELD_RULES) {
            const rawValue = raw[rule.field];
            if (typeof rawValue !== 'string') continue;
            const value = rawValue.trim().toUpperCase();
            if (value === '') continue;
            this.reportUnseen(rule.field, value);
            const flag = rule.read(value);
            if (flag === undefined) continue;
            status[rule.flag] = flag;
            read = true;
        }
        return read;
    }

    private reportUnseen(field: string, value: string): void {
        const key = `${field}=${value}`;
        if (KNOWN_VALUES[field]?.includes(value) || this.reportedValues.has(key)) return;
        this.reportedValues.add(key);
        this.log.info(
            `Zone status field ${field} reported "${value}", a value not observed before; `
            + 'please report it with a debug capture so its meaning can be confirmed.',
        );
    }
}
