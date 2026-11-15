'use strict';

// What actually leaves for the panel: output command payloads (TD-T-04,
// mutations M47, M59, M62, M63, M64) and the PIN never reaching the log
// through the real send paths (TD-T-03, M22, M23).

const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { calculateCRC16 } = require('../dist/websocket-client/crc16.js');
const { seedDevices } = require('./fixtures/command-client.js');

const SYNTHETIC_PIN = '135790';
const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });
function recordingLog() {
    const lines = [];
    const push = (level) => (...a) => lines.push([level, a.map(String).join(' ')]);
    return { lines, log: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug'), success: push('info') } };
}

function loggedInClient() {
    const client = new KseniaWebSocketClient('127.0.0.1', 1, false, 'hb', SYNTHETIC_PIN, silentLog(), { commandTimeoutMs: 5000 });
    client['state'].idLogin = '77';
    client['state'].ws = { readyState: 1 };
    // Commands only reach discovered outputs (WS-01 defense in depth).
    seedDevices(client, ['light_12', 'cover_4']);
    const sent = [];
    client['wsTransport'].send = async (_ws, raw) => {
        const m = JSON.parse(raw);
        sent.push({ raw, m });
        setImmediate(() => client['commandDispatcher'].resolvePendingCommand({ ID: m.ID, CMD: 'CMD_USR_RES', PAYLOAD_TYPE: 'REPLY', PAYLOAD: { RESULT: 'OK', RESULT_DETAIL: 'CMD_PROCESSED' } }));
    };
    return { client, sent };
}

test('output commands carry the login id, the PIN, a valid CRC and the requested ON/OFF state', async () => {
    const { client, sent } = loggedInClient();
    await client.switchLight('light_12', true);
    await client.switchLight('light_12', false);
    assert.deepEqual(sent.map((s) => s.m.PAYLOAD.OUTPUT), [{ ID: '12', STA: 'ON' }, { ID: '12', STA: 'OFF' }]);
    for (const { raw, m } of sent) {
        assert.equal(m.CMD, 'CMD_USR');
        assert.equal(m.PAYLOAD_TYPE, 'CMD_SET_OUTPUT');
        assert.equal(m.PAYLOAD.ID_LOGIN, '77');
        assert.equal(m.PAYLOAD.PIN, SYNTHETIC_PIN);
        assert.equal(calculateCRC16(raw.replace(/"CRC_16":"0x[0-9a-f]{4}"/, '"CRC_16":"0x0000"')), m.CRC_16);
    }
});

test('cover commands map 0/100 to DOWN/UP and clamp out-of-range positions', async () => {
    const { client, sent } = loggedInClient();
    for (const position of [0, 100, 37.4, 150, -5]) await client.moveCover('cover_4', position);
    assert.deepEqual(sent.map((s) => s.m.PAYLOAD.OUTPUT.STA), ['DOWN', 'UP', '37', 'UP', 'DOWN']);
});

test('dimmer commands are clamped to 0..100', async () => {
    const { client, sent } = loggedInClient();
    for (const level of [250, -1, 42.6]) await client.dimLight('light_12', level);
    assert.deepEqual(sent.map((s) => s.m.PAYLOAD.OUTPUT.STA), ['100', '0', '43']);
});

test('LOGIN and CMD_USR frames are logged without the PIN (string and numeric)', async () => {
    for (const pin of [SYNTHETIC_PIN, Number(SYNTHETIC_PIN)]) {
        const { log, lines } = recordingLog();
        const client = new KseniaWebSocketClient('127.0.0.1', 1, false, 'hb', pin, log, { logLevel: 2, debug: true });
        client['state'].ws = { readyState: 1 };
        seedDevices(client, ['gate_3']);
        const sent = [];
        client['wsTransport'].send = async (_ws, raw) => {
            const m = JSON.parse(raw);
            sent.push(m);
            if (m.CMD === 'CMD_USR') setImmediate(() => client['commandDispatcher'].resolvePendingCommand({ ID: m.ID, CMD: 'CMD_USR_RES', PAYLOAD_TYPE: 'REPLY', PAYLOAD: { RESULT: 'OK' } }));
        };
        await client['commandService'].sendLoginCommand();
        client['state'].idLogin = '1';
        await client.toggleGate('gate_3');
        assert.equal(String(sent[0].PAYLOAD.PIN), SYNTHETIC_PIN, 'the LOGIN really carries the PIN');
        assert.equal(String(sent[1].PAYLOAD.PIN), SYNTHETIC_PIN, 'the command really carries the PIN');
        assert.ok(lines.some(([, l]) => l.includes('Sending:') && l.includes('LOGIN')), 'the LOGIN frame is logged');
        assert.ok(lines.some(([, l]) => l.includes('Sending:') && l.includes('CMD_SET_OUTPUT')), 'the command frame is logged at debug');
        for (const [level, line] of lines) assert.ok(!line.includes(SYNTHETIC_PIN), `PIN in ${level} log: ${line.replace(SYNTHETIC_PIN, '<PIN>')}`);
    }
});
