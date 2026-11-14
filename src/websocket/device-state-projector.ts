import type {
    KseniaCover,
    KseniaGate,
    KseniaLight,
    KseniaOutputData,
    KseniaThermostat,
} from '../types';
import { createDefaultThermostatState } from '../thermostat-state';
import { classifyOutput } from './output-classifier';

export { determineOutputType, OutputTypeMemory, type ProjectedOutputType } from './output-classifier';

/**
 * Normalise a raw Lares4 `DES` label at parse time: trim and collapse
 * internal whitespace runs. The panel ships labels like `"Hall Lamp "`
 * (trailing space) which would otherwise leak into HAP names (triggering
 * HAP-NodeJS `checkName` warnings), MQTT payloads and the Matter sanitiser.
 * Domain names must be born clean; ids/UUIDs are never derived from names.
 */
export function normalizeDeviceName(raw: string | undefined): string {
    if (typeof raw !== 'string') return '';
    return raw.replace(/\s+/g, ' ').trim();
}

export function parseOutputDevice(
    outputData: KseniaOutputData,
): KseniaLight | KseniaCover | KseniaGate | KseniaThermostat {
    const systemId = outputData.ID;
    const outputType = classifyOutput(outputData);
    const label = normalizeDeviceName(outputData.DES);

    if (outputType === 'light') {
        return {
            id: `light_${systemId}`,
            type: 'light',
            name: label || `Light ${systemId}`,
            description: label,
            status: {
                on: false,
                brightness: undefined,
                dimmable: false,
            },
        };
    }

    if (outputType === 'cover') {
        return {
            id: `cover_${systemId}`,
            type: 'cover',
            name: label || `Cover ${systemId}`,
            description: label,
            status: {
                position: 0,
                state: 'stopped',
            },
        };
    }

    if (outputType === 'gate') {
        return {
            id: `gate_${systemId}`,
            type: 'gate',
            name: label || `Gate ${systemId}`,
            description: label,
            status: {
                on: false,
            },
        };
    }

    const thermostatState = createDefaultThermostatState();
    return {
        id: `thermostat_${systemId}`,
        type: 'thermostat',
        name: label || `Thermostat ${systemId}`,
        description: label,
        ...thermostatState,
    };
}

export function clampValue(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.max(min, Math.min(max, value));
}

const INTEGER_TEXT = /^[+-]?\d+$/;
const DECIMAL_TEXT = /^[+-]?\d+(?:[.,]\d+)?$/;

/**
 * A panel reading as a number, or `undefined` when it is not one: absent,
 * empty, `NA`, garbage, not finite, or outside `[min, max]`. Out-of-range
 * values are discarded, never clamped: a probe reporting 999 is a fault, and
 * publishing it as the range limit would be a fabricated measurement.
 */
function parseReading(value: unknown, pattern: RegExp, min: number, max: number): number | undefined {
    let parsed: number;
    if (typeof value === 'number') {
        parsed = value;
    } else if (typeof value === 'string') {
        const text = value.trim();
        if (!pattern.test(text)) return undefined;
        parsed = Number(text.replace(',', '.'));
    } else {
        return undefined;
    }
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return undefined;
    return parsed;
}

export function parseIntegerInRange(value: unknown, min: number, max: number): number | undefined {
    const parsed = parseReading(value, INTEGER_TEXT, min, max);
    return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

export function parseFloatInRange(value: unknown, min: number, max: number): number | undefined {
    return parseReading(value, DECIMAL_TEXT, min, max);
}

/** `ON`/`OFF` in any case and spacing; `undefined` for anything else. */
export function parseOnOff(value: unknown): boolean | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toUpperCase();
    if (normalized === 'ON') return true;
    if (normalized === 'OFF') return false;
    return undefined;
}

/**
 * Cover position from `POS`, or from an end-of-travel `STA` when there is no
 * `POS`. `undefined` (position unknown, keep the last one) for an unreadable
 * `POS`, for `STOP` without `POS` and for an unknown `STA`.
 */
export function mapCoverPosition(sta: unknown, pos?: unknown): number | undefined {
    if (pos !== undefined && pos !== '') {
        return parseIntegerInRange(pos, 0, 100);
    }

    switch (typeof sta === 'string' ? sta.trim().toUpperCase() : undefined) {
        case 'OPEN':
        case 'UP':
            return 100;
        case 'CLOSE':
        case 'DOWN':
            return 0;
        default:
            return undefined;
    }
}

export function mapCoverState(
    sta: unknown,
    pos?: unknown,
    tpos?: unknown,
): 'stopped' | 'opening' | 'closing' {
    if (pos !== undefined && tpos !== undefined) {
        const currentPos = parseIntegerInRange(pos, 0, 100);
        const targetPos = parseIntegerInRange(tpos, 0, 100);

        if (currentPos === undefined || targetPos === undefined) {
            return 'stopped';
        }

        if (currentPos === targetPos) {
            return 'stopped';
        } else if (currentPos < targetPos) {
            return 'opening';
        } else {
            return 'closing';
        }
    }

    switch (typeof sta === 'string' ? sta.trim().toUpperCase() : undefined) {
        case 'UP':
        case 'OPEN':
            return 'opening';
        case 'DOWN':
        case 'CLOSE':
            return 'closing';
        case 'STOP':
        default:
            return 'stopped';
    }
}
