import type { KseniaMessage } from '../types';
import { calculateCRC16 } from './crc16';

export type InboundFrame =
    | { kind: 'frame'; message: KseniaMessage; crc: 'valid' | 'missing' }
    | { kind: 'rejected'; reason: string };

/**
 * Parses one text frame from the panel and checks it before anything reads
 * it: a JSON object with a string `CMD`, an object `PAYLOAD` (absent reads as
 * empty) and a `CRC_16` that matches the frame. The panel computes the CRC
 * with the same algorithm the plugin uses to send (verified on every inbound
 * frame of the available real captures), so a mismatch is a corrupted frame.
 * Rejection reasons never quote the frame: it may carry names of the site.
 */
export function readInboundFrame(raw: string): InboundFrame {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { kind: 'rejected', reason: `Invalid JSON frame from the panel (${raw.length} bytes)` };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { kind: 'rejected', reason: 'Panel frame that is not a JSON object' };
    }
    const message = parsed as Record<string, unknown>;
    if (typeof message.CMD !== 'string') {
        return { kind: 'rejected', reason: 'Panel frame without CMD' };
    }
    if (message.PAYLOAD === undefined) {
        message.PAYLOAD = {};
    } else if (message.PAYLOAD === null || typeof message.PAYLOAD !== 'object' || Array.isArray(message.PAYLOAD)) {
        return { kind: 'rejected', reason: `Panel ${message.CMD} frame whose PAYLOAD is not an object` };
    }

    const declared = message.CRC_16;
    if (declared === undefined) {
        return { kind: 'frame', message: parsed as KseniaMessage, crc: 'missing' };
    }
    if (typeof declared !== 'string' || calculateCRC16(raw).toLowerCase() !== declared.trim().toLowerCase()) {
        return { kind: 'rejected', reason: `Panel ${message.CMD}/${String(message.PAYLOAD_TYPE)} frame with a wrong CRC_16` };
    }
    return { kind: 'frame', message: parsed as KseniaMessage, crc: 'valid' };
}
