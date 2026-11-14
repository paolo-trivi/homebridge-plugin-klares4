/**
 * Ksenia CRC16 over the UTF-8 bytes of the message up to and including the
 * `"CRC_16"` key. The bytes come from Buffer so characters outside the BMP
 * (emoji in a device name) are encoded exactly; the hand-rolled encoder used
 * before masked the low surrogate with 0x3f instead of 0x3ff.
 */
export function calculateCRC16(jsonString: string): string {
    const crcField = '"CRC_16"';
    const dataEnd = jsonString.lastIndexOf(crcField) + crcField.length;
    const bytes = Buffer.from(jsonString.slice(0, dataEnd), 'utf8');

    const seed = 0xffff;
    const poly = 0x1021;
    let crc = seed;
    for (const byte of bytes) {
        for (let iCrc = 0x80; iCrc; iCrc >>= 1) {
            const flagCrc = crc & 0x8000 ? 1 : 0;
            crc <<= 1;
            crc = crc & 0xffff;
            if (byte & iCrc) {
                crc++;
            }
            if (flagCrc) {
                crc ^= poly;
            }
        }
    }

    return '0x' + crc.toString(16).padStart(4, '0');
}
