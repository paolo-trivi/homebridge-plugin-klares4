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
 * internal whitespace runs. The panel ships labels like `"Balcone Sala "`
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

export function parseIntegerInRange(
    value: string | undefined,
    min: number,
    max: number,
): number | undefined {
    if (value === undefined || value === '') {
        return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }
    return clampValue(parsed, min, max);
}

export function parseFloatInRange(
    value: string | undefined,
    min: number,
    max: number,
): number | undefined {
    if (value === undefined || value === '') {
        return undefined;
    }
    const normalized = value.trim().replace(',', '.').replace('+', '');
    const parsed = Number.parseFloat(normalized);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }
    return clampValue(parsed, min, max);
}

export function mapCoverPosition(sta: string, pos?: string): number {
    if (pos !== undefined && pos !== '') {
        return parseIntegerInRange(pos, 0, 100) ?? 0;
    }

    switch (sta?.toUpperCase()) {
        case 'OPEN':
        case 'UP':
            return 100;
        case 'CLOSE':
        case 'DOWN':
            return 0;
        case 'STOP':
            return 50;
        default:
            return 0;
    }
}

export function mapCoverState(
    sta: string,
    pos?: string,
    tpos?: string,
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

    switch (sta?.toUpperCase()) {
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
