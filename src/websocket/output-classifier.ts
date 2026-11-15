import type { KseniaOutputData, OutputOptInType } from '../types';

export type ProjectedOutputType = 'light' | 'cover' | 'gate' | 'thermostat';

export type { OutputOptIn, OutputOptInType } from '../types';

export const OUTPUT_OPT_IN_TYPES: readonly OutputOptInType[] = ['light'];

/**
 * The type of an output of a recognized category; `undefined` for any other
 * category (`GEN`, `IRR`, empty, unknown): such an output is not a light, a
 * cover, a gate or a thermostat as far as the plugin can tell.
 *
 * The comparisons are exactly those of 2.2.0 (category upper-cased but not
 * trimmed, `MOD` compared as `M`): the type is the device ID prefix, so an
 * output 2.2.0 exposed keeps its ID, UUID and MQTT topic, or is hidden by the
 * fail-closed policy when 2.2.0 only reached it through its "light" default.
 */
export function determineOutputType(category: string, mode?: string): ProjectedOutputType | undefined {
    const catUpper = typeof category === 'string' ? category.toUpperCase() : '';

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

    return undefined;
}

/** For log lines only: classification uses the panel's value as listed. */
function displayed(value: unknown): string {
    return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

interface RememberedType {
    type: ProjectedOutputType;
    /** The upper-cased category the type was derived from. */
    category: string;
}

/**
 * Remembers, per panel output ID, the type of the last read that carried a
 * recognized category, for re-reads that do not say what the output is:
 * no (or a blank) category, or `GATE` without `MOD` for an output already
 * known from a `GATE` read. Without it such a re-read (e.g. a partial re-poll
 * during a reconnect) would flip the ID prefix and Matter/Alexa would see a
 * brand-new device. An explicit category always wins: an output reconfigured
 * on the panel (LIGHT → GATE) takes its new type, and its old device leaves
 * the client state with the end of the discovery round.
 * One instance per client: two panels may use the same output IDs.
 */
export class OutputTypeMemory {
    private readonly lastKnown = new Map<string, RememberedType>();

    /** The recognized type, or `undefined` for a category the plugin does not recognize. */
    resolve(systemId: string, category: string, mode?: string): ProjectedOutputType | undefined {
        const known = this.lastKnown.get(systemId);
        const catUpper = typeof category === 'string' ? category.toUpperCase() : '';
        if (known && (catUpper.trim() === '' || (catUpper === 'GATE' && known.category === 'GATE' && !mode))) {
            return known.type;
        }
        const computed = determineOutputType(category, mode);
        // A category the plugin does not recognize is a confident answer too:
        // a later read without a category must not bring the old type back.
        if (computed) this.lastKnown.set(systemId, { type: computed, category: catUpper });
        else this.lastKnown.delete(systemId);
        return computed;
    }
}

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
 * The type decided for one element of a discovery read, for `classifyOutput`
 * when the projector parses that same element right after. Keyed by the
 * element itself, so nothing outlives the read or crosses clients.
 */
const decidedTypes = new WeakMap<KseniaOutputData, ProjectedOutputType>();

/**
 * Fail-closed exposure of a discovered output: only recognized categories
 * (LIGHT, ROLL, GATE, thermostat) are exposed on their own; any other output
 * is exposed only when `exposeOutputs` lists its ID, as the type given there.
 * `memory` is the client's (see `OutputTypeMemory`).
 */
export function resolveOutputExposure(
    outputData: KseniaOutputData,
    optIns: ReadonlyMap<string, OutputOptInType>,
    memory: OutputTypeMemory,
): OutputExposure {
    const category = outputCategory(outputData);
    const type = memory.resolve(String(outputData.ID), category, outputData.MOD);
    const optIn = optIns.get(String(outputData.ID));
    const exposure: OutputExposure = type ? { exposed: true, type, source: 'category' }
        : optIn ? { exposed: true, type: optIn, source: 'opt-in' }
            : { exposed: false, category: displayed(category), mode: displayed(outputData.MOD) };
    if (exposure.exposed) decidedTypes.set(outputData, exposure.type);
    return exposure;
}

/**
 * Type of an output the exposure policy has let through: the one
 * `resolveOutputExposure` decided for this element, else its category (an
 * unrecognized one only gets here through `exposeOutputs`, whose type is `light`).
 */
export function classifyOutput(outputData: KseniaOutputData): ProjectedOutputType {
    return decidedTypes.get(outputData)
        ?? determineOutputType(outputCategory(outputData), outputData.MOD)
        ?? 'light';
}
