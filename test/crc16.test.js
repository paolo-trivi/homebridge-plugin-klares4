const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateCRC16 } = require('../dist/websocket-client/crc16.js');

// Byte-accurate reference: the Ksenia CRC (seed 0xFFFF, poly 0x1021, data bits
// shifted in MSB first) over the UTF-8 bytes up to and including "CRC_16".
function referenceCrc(json) {
    const bytes = new TextEncoder().encode(json);
    const marker = new TextEncoder().encode('"CRC_16"');
    let end = -1;
    for (let i = bytes.length - marker.length; i >= 0 && end < 0; i -= 1) {
        if (marker.every((byte, k) => bytes[i + k] === byte)) end = i + marker.length;
    }
    let crc = 0xffff;
    for (let i = 0; i < end; i += 1) {
        for (let bit = 0x80; bit; bit >>= 1) {
            const carry = crc & 0x8000;
            crc = ((crc << 1) & 0xffff) | (bytes[i] & bit ? 1 : 0);
            if (carry) crc ^= 0x1021;
        }
    }
    return '0x' + crc.toString(16).padStart(4, '0');
}

function message(des) {
    return JSON.stringify({
        SENDER: 'hb', RECEIVER: '', CMD: 'CMD_USR', ID: '1234', PAYLOAD_TYPE: 'CMD_SET_OUTPUT',
        PAYLOAD: { DES: des }, TIMESTAMP: '1700000000', CRC_16: '0x0000',
    });
}

test('CRC16 matches the byte-accurate reference for ASCII, accented Latin and emoji', () => {
    for (const des of ['Luce cucina', 'Tapparella soggiorno è già àperta ù', 'Scena 🌙 notte', '日本 💡🔒']) {
        assert.equal(calculateCRC16(message(des)), referenceCrc(message(des)), des);
    }
});

test('CRC16 values for ASCII and accented Latin are unchanged', () => {
    // Recorded from the previous implementation, which was already right for these.
    assert.equal(calculateCRC16(message('Luce cucina')), '0xd729');
    assert.equal(calculateCRC16(message('Tapparella soggiorno è già àperta ù')), '0x908f');
});
