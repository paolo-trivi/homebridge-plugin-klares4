import { isPlainRecord, redactFrame, redactText } from './redaction';
import type { RawMessage } from './types';

/**
 * One frame as it goes into the debug file. Sensitive keys are masked at any
 * depth, in both directions; what is not a JSON object is masked as text, so
 * a frame that cannot be understood is never written as it came.
 */
export function captureRawMessage(direction: 'in' | 'out', rawData: string): RawMessage {
    let parsed: Record<string, unknown> | null = null;
    let text: string;

    try {
        const message: unknown = JSON.parse(rawData);
        if (isPlainRecord(message)) {
            const redacted = redactFrame(message, direction);
            parsed = redacted.value;
            // The original text is kept byte for byte when there was nothing to mask.
            text = redacted.changed ? JSON.stringify(redacted.value) : rawData;
        } else {
            text = redactText(rawData);
        }
    } catch {
        parsed = null;
        text = redactText(rawData);
    }

    return {
        timestamp: new Date().toISOString(),
        direction,
        rawData: text,
        parsed,
    };
}
