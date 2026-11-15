'use strict';

// N-ws1: the inbound CRC runs on every frame, so it is computed a byte at a
// time from a table. It must give exactly the result of the bitwise algorithm
// of 2.2.0 (kept here as the reference) on any text, and stay fast.

const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateCRC16, crc16OfBytes } = require('../dist/websocket-client/crc16.js');

/** The 2.2.0 implementation, verbatim in behaviour. */
function bitwiseCrc16(jsonString) {
    const crcField = '"CRC_16"';
    const dataEnd = jsonString.lastIndexOf(crcField) + crcField.length;
    const bytes = Buffer.from(jsonString.slice(0, dataEnd), 'utf8');
    let crc = 0xffff;
    for (const byte of bytes) {
        for (let iCrc = 0x80; iCrc; iCrc >>= 1) {
            const flagCrc = crc & 0x8000 ? 1 : 0;
            crc <<= 1;
            crc = crc & 0xffff;
            if (byte & iCrc) crc++;
            if (flagCrc) crc ^= 0x1021;
        }
    }
    return '0x' + crc.toString(16).padStart(4, '0');
}

/** Deterministic pseudo-random generator: failures are reproducible. */
function rng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

const ALPHABET = [
    'a', 'Z', '0', ' ', '"', '\\', '{', '}', ':', ',', 'à', 'è', 'ì', 'ò', 'ù', 'ç', 'ß', '€', '°',
    '中', ' ', ' ', '😀', '🏠', '\ud83d', '\ude00', '\u0000', '\u007f', '\u0080', '￿',
];

function randomText(next, length) {
    let text = '';
    for (let i = 0; i < length; i += 1) text += ALPHABET[Math.floor(next() * ALPHABET.length)];
    return text;
}

test('N-ws1: the table CRC equals the bitwise CRC on random frames, non-ASCII and surrogate pairs included', () => {
    const next = rng(20261115);
    for (let i = 0; i < 2000; i += 1) {
        const frame = JSON.stringify({
            CMD: 'READ_RES', PAYLOAD: { DES: randomText(next, Math.floor(next() * 200)) }, CRC_16: '0x0000',
        });
        assert.equal(calculateCRC16(frame), bitwiseCrc16(frame), frame);
    }
    // Every single byte value and the empty input.
    for (let byte = 0; byte < 256; byte += 1) {
        assert.equal(crc16OfBytes(Uint8Array.of(byte, 0x41, byte)), bitwiseBytes(Uint8Array.of(byte, 0x41, byte)));
    }
    assert.equal(crc16OfBytes(new Uint8Array(0)), '0xffff');
});

function bitwiseBytes(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
        for (let bit = 0x80; bit; bit >>= 1) {
            const carry = crc & 0x8000;
            crc = ((crc << 1) & 0xffff) | (byte & bit ? 1 : 0);
            if (carry) crc ^= 0x1021;
        }
    }
    return '0x' + crc.toString(16).padStart(4, '0');
}

test('N-ws1: a 1 MB frame is checked in well under 200 ms', () => {
    const frame = JSON.stringify({ CMD: 'REALTIME', PAYLOAD: { x: 'àbc€'.repeat(250_000) }, CRC_16: '0x0000' });
    calculateCRC16(frame); // warm-up
    const started = process.hrtime.bigint();
    calculateCRC16(frame);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // The bitwise version took about 1.2 s on the same machine; the bound is wide for loaded CI runners.
    assert.ok(elapsedMs < 200, `${elapsedMs.toFixed(1)} ms`);
});
