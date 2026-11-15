'use strict';

// Frames as the panel sends them: CRC_16 last, computed over the frame like
// a real Lares4 does. The client drops inbound frames whose CRC is wrong
// (WS-14), so every frame a fake panel sends must be signed.

const { calculateCRC16 } = require('../../dist/websocket-client/crc16.js');

/** JSON text of `message` with CRC_16 moved last and set to the right value. */
function signFrame(message) {
    const { CRC_16: _ignored, ...fields } = message;
    const unsigned = JSON.stringify({ ...fields, CRC_16: '0x0000' });
    return `${unsigned.slice(0, -'"0x0000"}'.length)}"${calculateCRC16(unsigned)}"}`;
}

module.exports = { signFrame };
