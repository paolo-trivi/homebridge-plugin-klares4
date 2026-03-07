export function calculateCRC16(jsonString: string): string {
    const utf8: number[] = [];
    for (let i = 0; i < jsonString.length; i++) {
        const charcode = jsonString.charCodeAt(i);
        if (charcode < 0x80) {
            utf8.push(charcode);
        } else if (charcode < 0x800) {
            utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
        } else if (charcode < 0xd800 || charcode >= 0xe000) {
            utf8.push(
                0xe0 | (charcode >> 12),
                0x80 | ((charcode >> 6) & 0x3f),
                0x80 | (charcode & 0x3f),
            );
        } else {
            i++;
            const surrogate =
                0x10000 + (((charcode & 0x3ff) << 10) | (jsonString.charCodeAt(i) & 0x3f));
            utf8.push(
                0xf0 | (surrogate >> 18),
                0x80 | ((surrogate >> 12) & 0x3f),
                0x80 | ((surrogate >> 6) & 0x3f),
                0x80 | (surrogate & 0x3f),
            );
        }
    }

    const seed = 0xffff;
    const poly = 0x1021;
    const crcField = '"CRC_16"';
    const dataLen =
        jsonString.lastIndexOf(crcField) + crcField.length + (utf8.length - jsonString.length);

    let crc = seed;
    for (let i = 0; i < dataLen; i++) {
        const charCode = utf8[i];
        for (let iCrc = 0x80; iCrc; iCrc >>= 1) {
            const flagCrc = crc & 0x8000 ? 1 : 0;
            crc <<= 1;
            crc = crc & 0xffff;
            if (charCode & iCrc) {
                crc++;
            }
            if (flagCrc) {
                crc ^= poly;
            }
        }
    }

    return '0x' + crc.toString(16).padStart(4, '0');
}
