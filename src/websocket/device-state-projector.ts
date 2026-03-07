import type {
    KseniaCover,
    KseniaGate,
    KseniaLight,
    KseniaOutputData,
    KseniaThermostat,
} from '../types';
import { createDefaultThermostatState } from '../thermostat-state';

export type ProjectedOutputType = 'light' | 'cover' | 'gate' | 'thermostat';

export function determineOutputType(category: string, mode?: string): ProjectedOutputType {
    const catUpper = category.toUpperCase();

    if (catUpper === 'ROLL') {
        return 'cover';
    }

    if (catUpper === 'LIGHT') {
        return 'light';
    }

    if (catUpper === 'GATE') {
        if (mode === 'M') {
            return 'gate';
        }
        return 'cover';
    }

    if (
        catUpper.includes('THERM') ||
        catUpper.includes('CLIMA') ||
        catUpper.includes('TEMP') ||
        catUpper.includes('RISCALD') ||
        catUpper.includes('RAFFRES') ||
        catUpper.includes('HVAC') ||
        catUpper.includes('TERMOS')
    ) {
        return 'thermostat';
    }

    return 'light';
}

export function parseOutputDevice(
    outputData: KseniaOutputData,
): KseniaLight | KseniaCover | KseniaGate | KseniaThermostat {
    const category = outputData.CAT ?? outputData.TYPE ?? '';
    const systemId = outputData.ID;
    const outputType = determineOutputType(category, outputData.MOD);

    if (outputType === 'light') {
        return {
            id: `light_${systemId}`,
            type: 'light',
            name: outputData.DES || `Light ${systemId}`,
            description: outputData.DES || '',
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
            name: outputData.DES || `Cover ${systemId}`,
            description: outputData.DES || '',
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
            name: outputData.DES || `Gate ${systemId}`,
            description: outputData.DES || '',
            status: {
                on: false,
            },
        };
    }

    const thermostatState = createDefaultThermostatState();
    return {
        id: `thermostat_${systemId}`,
        type: 'thermostat',
        name: outputData.DES || `Thermostat ${systemId}`,
        description: outputData.DES || '',
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
    const parsed = Number.parseFloat(value.replace('+', ''));
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
