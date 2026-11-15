import type { KseniaMessage } from '../types';
import { calculateCRC16 } from './crc16';

export type InboundFrame =
    | { kind: 'frame'; message: KseniaMessage; crc: 'valid' | 'missing' }
    /** Non-ASCII frame whose CRC differs: accepted, with the encodings tried. */
    | { kind: 'frame'; message: KseniaMessage; crc: 'unverified'; matchingEncoding?: string }
    | { kind: 'rejected'; reason: string };

/**
 * Parses one text frame from the panel and checks it before anything reads
 * it: a JSON object with a string `CMD`, an object `PAYLOAD` (absent reads as
 * empty) and a `CRC_16` that matches the frame. The panel computes the CRC
 * with the same algorithm the plugin uses to send, verified on every inbound
 * frame of the available real captures, all of them ASCII: a mismatch on an
 * ASCII frame is a corrupted frame and is dropped. How the panel encodes
 * other characters (accented names) is not verified, so a non-ASCII frame
 * whose CRC differs is accepted and reported, with the encoding that
 * matches if any.
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
    const expected = typeof declared === 'string' ? declared.trim().toLowerCase() : undefined;
    if (expected !== undefined && calculateCRC16(raw).toLowerCase() === expected) {
        return { kind: 'frame', message: parsed as KseniaMessage, crc: 'valid' };
    }
    if (expected === undefined || ASCII_ONLY.test(raw)) {
        return { kind: 'rejected', reason: `Panel ${message.CMD}/${String(message.PAYLOAD_TYPE)} frame with a wrong CRC_16` };
    }
    return { kind: 'frame', message: parsed as KseniaMessage, crc: 'unverified', matchingEncoding: matchingEncoding(raw, expected) };
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/** Byte encodings of the CRC'd text a panel could plausibly use instead of UTF-8. */
const CANDIDATE_ENCODINGS: ReadonlyArray<[string, (text: string) => Uint8Array]> = [
    ['latin1', (text) => Buffer.from(text, 'latin1')],
    ['utf16le', (text) => Buffer.from(text, 'utf16le')],
    ['utf16-low-byte', (text) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff)],
];

function matchingEncoding(raw: string, expected: string): string | undefined {
    const crcField = '"CRC_16"';
    const text = raw.slice(0, raw.lastIndexOf(crcField) + crcField.length);
    return CANDIDATE_ENCODINGS.find(([, encode]) => crc16OfBytes(encode(text)) === expected)?.[0];
}

/** The algorithm of `crc16.ts` over raw bytes (lower-case hex, as compared above). */
export function crc16OfBytes(bytes: Uint8Array): string {
    let crc = 0xffff;
    for (const byte of bytes) {
        for (let bit = 0x80; bit; bit >>= 1) {
            const carry = crc & 0x8000;
            crc = ((crc << 1) & 0xffff) + (byte & bit ? 1 : 0);
            if (carry) crc ^= 0x1021;
        }
    }
    return `0x${crc.toString(16).padStart(4, '0')}`;
}
