/**
 * One reading of the panel's `RESULT` field for every consumer (router,
 * login, discovery reads, realtime registration): trimmed and upper-cased,
 * `undefined` when absent or not a string. A frame whose RESULT is anything
 * but `OK` is a refusal, wherever it is checked.
 */
export function normalizeResult(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toUpperCase();
    return normalized === '' ? undefined : normalized;
}

export interface ResultCarrier {
    PAYLOAD?: { RESULT?: unknown; RESULT_DETAIL?: unknown } | null;
}

/** Normalized RESULT of a frame; a RESULT present but not a string reads as `INVALID`. */
export function frameResult(message: ResultCarrier): string | undefined {
    const raw = message.PAYLOAD?.RESULT;
    if (raw === undefined || raw === null) return undefined;
    return normalizeResult(raw) ?? 'INVALID';
}

export function isPositiveResult(message: ResultCarrier): boolean {
    return frameResult(message) === 'OK';
}

/** `RESULT_DETAIL` trimmed, for logs; `undefined` when absent. */
export function resultDetail(message: ResultCarrier): string | undefined {
    const detail = message.PAYLOAD?.RESULT_DETAIL;
    if (typeof detail !== 'string') return undefined;
    const trimmed = detail.trim();
    return trimmed === '' ? undefined : trimmed;
}
