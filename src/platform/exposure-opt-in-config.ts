import type { OutputOptIn, OutputOptInType, ScenarioOptIn } from '../types';
import { OUTPUT_OPT_IN_TYPES } from '../websocket/output-classifier';
import { cite, ConfigIssues, isPlainObject, typeName } from './config-values';

const NUMERIC_ID = /^\d+$/;

/**
 * A panel ID as written in an opt-in row: a number, a string of digits (spaces
 * trimmed) or the device ID form (`light_7`, `output_7`, `scenario_4`).
 */
function panelId(raw: unknown, family: RegExp): string | undefined {
    let text: string;
    if (typeof raw === 'number') {
        if (!Number.isSafeInteger(raw) || raw < 0) return undefined;
        text = String(raw);
    } else if (typeof raw === 'string') {
        text = raw.trim();
    } else {
        return undefined;
    }
    const digits = NUMERIC_ID.test(text) ? text : family.exec(text)?.[1];
    if (digits === undefined) return undefined;
    const value = Number(digits);
    return Number.isSafeInteger(value) ? String(value) : undefined;
}

function rows(raw: unknown, key: string, issues: ConfigIssues): unknown[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        issues.warn(key, `expected an array of objects, received ${typeName(raw)}; nothing is exposed by it`);
        return [];
    }
    return raw;
}

function readExposeAs(raw: unknown): OutputOptInType | undefined {
    // A single type today: a row that names none means it.
    if (raw === undefined || raw === null || raw === '') return 'light';
    if (typeof raw !== 'string') return undefined;
    const normalized = raw.trim().toLowerCase();
    return OUTPUT_OPT_IN_TYPES.find((type) => type === normalized);
}

/**
 * `exposeOutputs`: `[{ outputId, exposeAs }]`, one row per output of an
 * unrecognized category (GEN, IRR, none) the user wants exposed anyway.
 * Invalid rows are dropped and reported; two rows for one output keep the last.
 */
export function normalizeOutputOptIns(raw: unknown, issues: ConfigIssues = new ConfigIssues()): OutputOptIn[] {
    const byId = new Map<string, OutputOptIn>();
    rows(raw, 'exposeOutputs', issues).forEach((row, index) => {
        const where = `exposeOutputs[${index}]`;
        if (!isPlainObject(row)) {
            issues.warn(where, `expected an object with outputId and exposeAs, received ${typeName(row)}; ignoring it`);
            return;
        }
        const outputId = panelId(row.outputId, /^(?:light|output)_(\d+)$/);
        if (outputId === undefined) {
            issues.warn(where, `outputId ${cite(row.outputId)} is not an output ID; ignoring the row`);
            return;
        }
        const exposeAs = readExposeAs(row.exposeAs);
        if (exposeAs === undefined) {
            issues.warn(
                where,
                `exposeAs ${cite(row.exposeAs)} is not one of ${OUTPUT_OPT_IN_TYPES.join(', ')}; output ${outputId} stays hidden`,
            );
            return;
        }
        if (byId.has(outputId)) issues.warn(where, `output ${outputId} is listed more than once; the last row wins`);
        byId.set(outputId, { outputId, exposeAs });
    });
    return [...byId.values()];
}

/**
 * `exposeScenarios`: `[{ scenarioId }]`, one row per scenario of an
 * unrecognized category the user wants exposed anyway. It never exposes
 * ARM/DISARM, and PARTIAL only follows `exposePartialArmScenarios`.
 */
export function normalizeScenarioOptIns(raw: unknown, issues: ConfigIssues = new ConfigIssues()): ScenarioOptIn[] {
    const ids = new Set<string>();
    rows(raw, 'exposeScenarios', issues).forEach((row, index) => {
        const where = `exposeScenarios[${index}]`;
        if (!isPlainObject(row)) {
            issues.warn(where, `expected an object with scenarioId, received ${typeName(row)}; ignoring it`);
            return;
        }
        const scenarioId = panelId(row.scenarioId, /^scenario_(\d+)$/);
        if (scenarioId === undefined) {
            issues.warn(where, `scenarioId ${cite(row.scenarioId)} is not a scenario ID; ignoring the row`);
            return;
        }
        ids.add(scenarioId);
    });
    return [...ids].map((scenarioId): ScenarioOptIn => ({ scenarioId }));
}
