import type { Logger } from 'homebridge';

/**
 * Problems found while turning the raw Homebridge config into the runtime
 * config. They are collected and reported once, together, at startup.
 * Messages name the key and the received *type*; a value is quoted only for
 * numbers and short device IDs, never for strings that may be a secret.
 */
export class ConfigIssues {
    private readonly warnings: string[] = [];
    private readonly errors: string[] = [];

    public warn(key: string, message: string): void {
        this.warnings.push(`${key}: ${message}`);
    }

    /** The configuration cannot be used as written (the plugin does not start). */
    public error(key: string, message: string): void {
        this.errors.push(`${key}: ${message}`);
    }

    public get count(): number {
        return this.warnings.length + this.errors.length;
    }

    public flush(log: Logger): void {
        for (const error of this.errors) log.error(`Invalid configuration, ${error}`);
        if (this.warnings.length === 0) return;
        const shown = this.warnings.slice(0, MAX_LISTED_WARNINGS);
        const hidden = this.warnings.length - shown.length;
        const lines = shown.map((warning) => `  - ${warning}`);
        if (hidden > 0) lines.push(`  - ...and ${hidden} more`);
        log.warn(
            `Configuration: ${this.warnings.length} value(s) ignored or adjusted `
            + `(fix them in the plugin settings):\n${lines.join('\n')}`,
        );
    }
}

const MAX_LISTED_WARNINGS = 25;
const MAX_QUOTED_LENGTH = 40;

export function typeName(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

/** A device ID or number as written by the user; any other value by its type only. */
export function cite(value: unknown): string {
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string') return `a value of type ${typeName(value)}`;
    const text = value.length > MAX_QUOTED_LENGTH ? `${value.slice(0, MAX_QUOTED_LENGTH)}...` : value;
    return JSON.stringify(text);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasOwn(target: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(target, key);
}

/** Own-property write that is safe for keys such as `__proto__`. */
export function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Boolean option. Only a real boolean is interpreted: `"false"`, `0`, `1`
 * and `"true"` fall back to the safe default and are reported. Absent
 * (`undefined`/`null`) is the default without a warning.
 */
export function readBoolean(raw: unknown, defaultValue: boolean, key: string, issues: ConfigIssues): boolean {
    if (raw === true || raw === false) return raw;
    if (raw !== undefined && raw !== null) {
        issues.warn(key, `expected true or false, received ${typeName(raw)}; using the default (${defaultValue})`);
    }
    return defaultValue;
}

export function readString(raw: unknown, key: string, issues: ConfigIssues): string | undefined {
    if (typeof raw === 'string') return raw;
    if (raw !== undefined && raw !== null) {
        issues.warn(key, `expected a string, received ${typeName(raw)}; ignoring it`);
    }
    return undefined;
}

export interface NumberSpec {
    readonly integer: boolean;
    readonly min?: number;
    readonly max?: number;
    readonly default?: number;
    /** The only accepted values (schema `oneOf`/`enum`); anything else is the default. */
    readonly oneOf?: readonly number[];
    /** Out-of-range handling: the nearest limit (default) or the default value. */
    readonly outOfRange?: 'clamp' | 'default';
}

export function readNumber(raw: unknown, spec: NumberSpec & { default: number }, key: string, issues: ConfigIssues): number;
export function readNumber(raw: unknown, spec: NumberSpec, key: string, issues: ConfigIssues): number | undefined;
export function readNumber(raw: unknown, spec: NumberSpec, key: string, issues: ConfigIssues): number | undefined {
    if (raw === undefined || raw === null) return spec.default;
    const fallback = spec.default === undefined ? 'ignoring it' : `using the default (${spec.default})`;
    if (typeof raw !== 'number') {
        issues.warn(key, `expected a number, received ${typeName(raw)}; ${fallback}`);
        return spec.default;
    }
    if (!Number.isFinite(raw)) {
        issues.warn(key, `${String(raw)} is not a finite number; ${fallback}`);
        return spec.default;
    }
    if (spec.integer && !Number.isInteger(raw)) {
        issues.warn(key, `${raw} is not an integer; ${fallback}`);
        return spec.default;
    }
    if (spec.oneOf) {
        if (spec.oneOf.includes(raw)) return raw;
        issues.warn(key, `${raw} is not one of ${spec.oneOf.join(', ')}; ${fallback}`);
        return spec.default;
    }
    const { min, max } = spec;
    const below = min !== undefined && raw < min;
    const above = max !== undefined && raw > max;
    if (!below && !above) return raw;
    if (spec.outOfRange === 'default') {
        issues.warn(key, `${raw} is outside ${min ?? '-'}..${max ?? '-'}; ${fallback}`);
        return spec.default;
    }
    const limit = below ? min : max;
    issues.warn(key, `${raw} is ${below ? 'below the minimum' : 'above the maximum'} ${limit}; using ${limit}`);
    return limit;
}
