import { createHash } from 'crypto';
import type { KseniaDevice } from '../types';
import type { MatterNameMapEntry } from './matter-name-map';

const ABBREVIATIONS: Record<string, string> = {
    sens: 'sensore',
    tapp: 'tapparella',
    term: 'termostato',
    cab: 'cabina',
    balc: 'balcone',
    matrim: 'matrimoniale',
    tv: 'televisione',
};

const SINGULAR: Record<string, string> = {
    luci: 'luce',
    finestre: 'finestra',
    tapparelle: 'tapparella',
    sensori: 'sensore',
    cancelli: 'cancello',
    scenari: 'scenario',
    termostati: 'termostato',
    volumetrici: 'volumetrico',
};

const ACTION_VERBS = new Set(['accendi', 'spegni', 'apri', 'chiudi', 'attiva', 'inserisci']);
const GLOBAL_INTENTS = new Set(['spegni tutto', 'accendi tutto', 'apri tutto', 'chiudi tutto']);
const PASSIVE_TYPES = new Set(['zone', 'sensor']);

export type LexicalEvidence =
    | 'exact'
    | 'normalized'
    | 'abbreviation'
    | 'singular-plural'
    | 'prefix'
    | 'containment'
    | 'artificial-suffix-root'
    | 'truncation-loss';

export type VoiceRiskReason =
    | 'room-equality'
    | 'intent-collision'
    | 'scenario-verb-entity'
    | 'active-passive-shadow'
    | 'cross-type-conflict';

export interface NormalizedVoiceName {
    literal: string;
    normalized: string;
    expanded: string;
    singular: string;
    tokens: string[];
}

export interface VoiceCollisionFinding {
    leftId: string;
    leftName: string;
    rightId: string;
    rightName: string;
    score: number;
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    lexicalEvidence: LexicalEvidence[];
    riskReasons: VoiceRiskReason[];
}

export interface VoiceAnalysisResult {
    findings: VoiceCollisionFinding[];
    hash: string;
}

function basicNormalize(value: string): string {
    return value.normalize('NFKC')
        .toLocaleLowerCase('it-IT')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

export function normalizeVoiceName(value: string): NormalizedVoiceName {
    const literal = basicNormalize(value);
    const rawTokens = literal.split(' ').filter(Boolean);
    const expandedTokens = rawTokens.map((token) => ABBREVIATIONS[token] ?? token);
    const singularTokens = expandedTokens.map((token) => SINGULAR[token] ?? token);
    return {
        literal,
        normalized: literal.normalize('NFD').replace(/\p{M}/gu, ''),
        expanded: expandedTokens.join(' '),
        singular: singularTokens.join(' '),
        tokens: singularTokens,
    };
}

function isPrefix(a: string[], b: string[]): boolean {
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    return shorter.length > 0 && shorter.length < longer.length
        && shorter.every((token, index) => token === longer[index]);
}

function isContainment(a: string[], b: string[]): boolean {
    const left = new Set(a);
    const right = new Set(b);
    const smaller = left.size <= right.size ? left : right;
    const larger = left.size <= right.size ? right : left;
    return smaller.size > 0 && smaller.size < larger.size
        && [...smaller].every((token) => larger.has(token));
}

function severity(score: number): VoiceCollisionFinding['severity'] {
    if (score >= 90) return 'CRITICAL';
    if (score >= 70) return 'HIGH';
    if (score >= 45) return 'MEDIUM';
    return 'LOW';
}

function hasTruncationLoss(device: KseniaDevice, entry: MatterNameMapEntry): boolean {
    const finalAtLimit = Array.from(entry.name).length === 32 && entry.name !== entry.base;
    const baseAtLimit = Array.from(entry.base).length === 32
        && Array.from(device.name.normalize('NFKC')).length > Array.from(entry.base).length;
    return finalAtLimit || baseAtLimit;
}

function analyzePair(
    left: KseniaDevice,
    right: KseniaDevice,
    entries: Map<string, MatterNameMapEntry>,
): VoiceCollisionFinding | undefined {
    const leftEntry = entries.get(left.id);
    const rightEntry = entries.get(right.id);
    if (!leftEntry || !rightEntry || leftEntry.reserved || rightEntry.reserved) return undefined;
    const a = normalizeVoiceName(leftEntry.name);
    const b = normalizeVoiceName(rightEntry.name);
    const evidence: LexicalEvidence[] = [];
    let base = 0;

    if (a.literal === b.literal) {
        evidence.push('exact');
        base = 100;
    } else if (a.normalized === b.normalized) {
        evidence.push('normalized');
        base = 96;
    } else if (a.expanded === b.expanded) {
        evidence.push('abbreviation');
        base = 88;
    } else if (a.singular === b.singular) {
        evidence.push('singular-plural');
        base = 88;
    } else if (normalizeVoiceName(leftEntry.base).singular === normalizeVoiceName(rightEntry.base).singular) {
        evidence.push('artificial-suffix-root');
        base = 94;
    } else if (isPrefix(a.tokens, b.tokens)) {
        evidence.push('prefix');
        base = 76;
    } else if (isContainment(a.tokens, b.tokens)) {
        evidence.push('containment');
        base = 58;
    }
    if (base === 0) return undefined;

    const truncationLoss = hasTruncationLoss(left, leftEntry) || hasTruncationLoss(right, rightEntry);
    if (truncationLoss) evidence.push('truncation-loss');

    const risks: VoiceRiskReason[] = [];
    const onePassive = PASSIVE_TYPES.has(left.type) !== PASSIVE_TYPES.has(right.type);
    if (onePassive) risks.push('active-passive-shadow');
    if (left.type !== right.type) risks.push('cross-type-conflict');
    const scenario = left.type === 'scenario' ? a : right.type === 'scenario' ? b : undefined;
    const entity = left.type === 'scenario' ? b : a;
    if (scenario && ACTION_VERBS.has(scenario.tokens[0])
        && scenario.tokens.slice(1).join(' ') === entity.singular) {
        risks.push('scenario-verb-entity');
        base = Math.max(base, 92);
    }
    const score = Math.min(
        100,
        base + (onePassive ? 8 : 0) + (left.type !== right.type ? 6 : 0) + (truncationLoss ? 8 : 0),
    );
    return {
        leftId: left.id,
        leftName: leftEntry.name,
        rightId: right.id,
        rightName: rightEntry.name,
        score,
        severity: severity(score),
        lexicalEvidence: evidence,
        riskReasons: risks,
    };
}

export function analyzeMatterVoiceCollisions(
    devices: Iterable<KseniaDevice>,
    entries: Map<string, MatterNameMapEntry>,
    roomNames: string[] = [],
): VoiceAnalysisResult {
    const liveDevices = [...devices].filter((device) => !entries.get(device.id)?.reserved)
        .sort((a, b) => a.id.localeCompare(b.id));
    const findings: VoiceCollisionFinding[] = [];
    for (let left = 0; left < liveDevices.length; left += 1) {
        for (let right = left + 1; right < liveDevices.length; right += 1) {
            const finding = analyzePair(liveDevices[left], liveDevices[right], entries);
            if (finding) findings.push(finding);
        }
    }
    for (const device of liveDevices) {
        const entry = entries.get(device.id);
        if (!entry) continue;
        const normalized = normalizeVoiceName(entry.name).singular;
        if (device.type === 'scenario' && GLOBAL_INTENTS.has(normalized)) {
            findings.push(namespaceFinding(device, entry.name, 'intent:global', normalized, 100, 'intent-collision'));
        }
        for (const room of roomNames) {
            if (normalized === normalizeVoiceName(room).singular) {
                findings.push(namespaceFinding(device, entry.name, `room:${room}`, room, 100, 'room-equality'));
            }
        }
    }
    findings.sort((a, b) => b.score - a.score
        || a.leftId.localeCompare(b.leftId)
        || a.rightId.localeCompare(b.rightId));
    const hash = createHash('sha256').update(JSON.stringify(findings)).digest('hex').slice(0, 16);
    return { findings, hash };
}

function namespaceFinding(
    device: KseniaDevice,
    name: string,
    rightId: string,
    rightName: string,
    score: number,
    reason: VoiceRiskReason,
): VoiceCollisionFinding {
    return {
        leftId: device.id,
        leftName: name,
        rightId,
        rightName,
        score,
        severity: severity(score),
        lexicalEvidence: ['exact'],
        riskReasons: [reason],
    };
}
