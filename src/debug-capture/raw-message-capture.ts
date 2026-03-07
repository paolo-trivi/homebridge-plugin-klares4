import type { RawMessage } from './types';

export function captureRawMessage(direction: 'in' | 'out', rawData: string): RawMessage {
    let parsed: Record<string, unknown> | null = null;
    let maskedData = rawData;

    try {
        const parsedMessage = JSON.parse(rawData) as unknown;
        if (isRecord(parsedMessage)) {
            parsed = parsedMessage;
        }

        if (parsed && isRecord(parsed.PAYLOAD) && typeof parsed.PAYLOAD.PIN === 'string') {
            const maskedParsed = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
            const maskedPayload = maskedParsed.PAYLOAD as Record<string, unknown>;
            maskedPayload.PIN = '***MASKED***';
            parsed = maskedParsed;
            maskedData = JSON.stringify(maskedParsed);
        }
    } catch {
        // Keep non-JSON payloads as-is.
    }

    return {
        timestamp: new Date().toISOString(),
        direction,
        rawData: maskedData,
        parsed,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
