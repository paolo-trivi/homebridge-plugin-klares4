import type { KseniaOutputData } from '../types';

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

/**
 * Determines whether (category, mode) carries enough information to classify
 * an output confidently. CAT is required, and category GATE specifically
 * needs MOD to tell a gate apart from a roller cover (see `determineOutputType`).
 */
function isAmbiguousClassification(category: string, mode?: string): boolean {
    const catUpper = category.toUpperCase();
    if (!catUpper) return true;
    if (catUpper === 'GATE' && !mode) return true;
    return false;
}

/**
 * Remembers the last confidently-classified output type per Klares4 system
 * ID, so a later update with missing/ambiguous CAT or MOD (e.g. a partial
 * re-poll during a WS reconnect) can't flip an already-known output's type —
 * which would change its `device.id` prefix (gate_/cover_/...) and make
 * Matter/Alexa perceive a brand-new device for the same physical output.
 */
export class OutputTypeMemory {
    private readonly lastKnownType = new Map<string, ProjectedOutputType>();

    resolve(systemId: string, category: string, mode?: string): ProjectedOutputType {
        const known = this.lastKnownType.get(systemId);
        if (known && isAmbiguousClassification(category, mode)) {
            return known;
        }
        const computed = determineOutputType(category, mode);
        this.lastKnownType.set(systemId, computed);
        return computed;
    }
}

const outputTypeMemory = new OutputTypeMemory();

/** Output category as the panel reports it: `CAT`, or `TYPE` on older firmware. */
export function outputCategory(outputData: KseniaOutputData): string {
    return outputData.CAT ?? outputData.TYPE ?? '';
}

/** Type of a discovered output, stable across ambiguous re-reads of the same ID. */
export function classifyOutput(outputData: KseniaOutputData): ProjectedOutputType {
    return outputTypeMemory.resolve(outputData.ID, outputCategory(outputData), outputData.MOD);
}
