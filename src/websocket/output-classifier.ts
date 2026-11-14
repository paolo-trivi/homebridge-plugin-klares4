import type { KseniaOutputData, OutputOptInType } from '../types';

export type ProjectedOutputType = 'light' | 'cover' | 'gate' | 'thermostat';

export type { OutputOptIn, OutputOptInType } from '../types';

export const OUTPUT_OPT_IN_TYPES: readonly OutputOptInType[] = ['light'];

/**
 * The type of an output of a recognized category; `undefined` for any other
 * category (`GEN`, `IRR`, empty, unknown): such an output is not a light, a
 * cover, a gate or a thermostat as far as the plugin can tell.
 */
export function determineOutputType(category: string, mode?: string): ProjectedOutputType | undefined {
    const catUpper = typeof category === 'string' ? category.trim().toUpperCase() : '';

    if (catUpper === 'ROLL') {
        return 'cover';
    }

    if (catUpper === 'LIGHT') {
        return 'light';
    }

    if (catUpper === 'GATE') {
        if (normalizedMode(mode) === 'M') {
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

    return undefined;
}

function normalizedMode(mode: unknown): string {
    return typeof mode === 'string' ? mode.trim().toUpperCase() : '';
}

/**
 * Determines whether (category, mode) carries enough information to classify
 * an output confidently. CAT is required, and category GATE specifically
 * needs MOD to tell a gate apart from a roller cover (see `determineOutputType`).
 */
function isAmbiguousClassification(category: string, mode?: string): boolean {
    const catUpper = category.trim().toUpperCase();
    if (!catUpper) return true;
    if (catUpper === 'GATE' && !normalizedMode(mode)) return true;
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

    /** The recognized type, or `undefined` for a category the plugin does not recognize. */
    resolve(systemId: string, category: string, mode?: string): ProjectedOutputType | undefined {
        const known = this.lastKnownType.get(systemId);
        if (known && isAmbiguousClassification(category, mode)) {
            return known;
        }
        const computed = determineOutputType(category, mode);
        // A category the plugin does not recognize is a confident answer too:
        // a later read without a category must not bring the old type back.
        if (computed) this.lastKnownType.set(systemId, computed);
        else this.lastKnownType.delete(systemId);
        return computed;
    }
}

const outputTypeMemory = new OutputTypeMemory();

/**
 * Output category as the panel reports it: `CAT`, or `TYPE` on older
 * firmware. A category that is not a string counts as missing.
 */
export function outputCategory(outputData: KseniaOutputData): string {
    const category: unknown = outputData.CAT ?? outputData.TYPE;
    return typeof category === 'string' ? category : '';
}

export type OutputExposure =
    | { exposed: true; type: ProjectedOutputType; source: 'category' | 'opt-in' }
    | { exposed: false; category: string; mode: string };

/**
 * Fail-closed exposure of a discovered output: only recognized categories
 * (LIGHT, ROLL, GATE, thermostat) are exposed on their own; any other output
 * is exposed only when `exposeOutputs` lists its ID, as the type given there.
 * An output already recognized in this process keeps its type when a re-read
 * comes without a category (see `OutputTypeMemory`).
 */
export function resolveOutputExposure(
    outputData: KseniaOutputData,
    optIns: ReadonlyMap<string, OutputOptInType>,
): OutputExposure {
    const category = outputCategory(outputData);
    const type = outputTypeMemory.resolve(String(outputData.ID), category, outputData.MOD);
    if (type) return { exposed: true, type, source: 'category' };
    const optIn = optIns.get(String(outputData.ID));
    if (optIn) return { exposed: true, type: optIn, source: 'opt-in' };
    return { exposed: false, category: category.trim().toUpperCase(), mode: normalizedMode(outputData.MOD) };
}

/**
 * Type of an output the exposure policy has let through, stable across
 * ambiguous re-reads of the same ID. An unrecognized category only gets here
 * through an `exposeOutputs` row, whose only type is `light`.
 */
export function classifyOutput(outputData: KseniaOutputData): ProjectedOutputType {
    return outputTypeMemory.resolve(String(outputData.ID), outputCategory(outputData), outputData.MOD) ?? 'light';
}
