/**
 * Ksenia CRC16 over the UTF-8 bytes of the message up to and including the
 * `"CRC_16"` key. The bytes come from Buffer so characters outside the BMP
 * (emoji in a device name) are encoded exactly; the hand-rolled encoder used
 * before masked the low surrogate with 0x3f instead of 0x3ff.
 */
export function calculateCRC16(jsonString: string): string {
    const crcField = '"CRC_16"';
    const dataEnd = jsonString.lastIndexOf(crcField) + crcField.length;
    return crc16OfBytes(Buffer.from(jsonString.slice(0, dataEnd), 'utf8'));
}

/**
 * The panel's CRC (seed 0xffff, polynomial 0x1021, message bits shifted in
 * at the low end, most significant bit first) over raw bytes, as `0x` and
 * four lower-case hex digits.
 *
 * Byte at a time: the bits of a byte enter at bit 0 and reach at most bit 7
 * in eight shifts, so the eight carries depend only on the high byte of the
 * CRC. Their XOR pattern is precomputed per high byte (`HIGH_BYTE_FEEDBACK`),
 * which gives the same result as the bitwise loop at a fraction of the cost
 * (it runs on every inbound frame).
 */
export function crc16OfBytes(bytes: Uint8Array): string {
    let crc = 0xffff;
    for (let i = 0; i < bytes.length; i += 1) {
        crc = (((crc << 8) & 0xffff) | bytes[i]) ^ HIGH_BYTE_FEEDBACK[crc >> 8];
    }
    return '0x' + crc.toString(16).padStart(4, '0');
}

const POLY = 0x1021;

const HIGH_BYTE_FEEDBACK: Uint16Array = ((): Uint16Array => {
    const table = new Uint16Array(256);
    for (let high = 0; high < 256; high += 1) {
        let crc = high << 8;
        for (let bit = 0; bit < 8; bit += 1) {
            const carry = crc & 0x8000;
            crc = (crc << 1) & 0xffff;
            if (carry) crc ^= POLY;
        }
        table[high] = crc;
    }
    return table;
})();
