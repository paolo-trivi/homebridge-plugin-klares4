'use strict';

// A socket close settles the pending command at once instead of letting it
// run into the command timeout (TD-T-09 in part, mutation M42).

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { seedDevices } = require('./fixtures/command-client.js');

const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });

test('a socket close rejects the pending command at once instead of letting it time out', { timeout: 10000 }, async (t) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => wss.on('listening', resolve));
    t.after(() => new Promise((resolve) => { for (const c of wss.clients) c.terminate(); wss.close(resolve); }));
    wss.on('connection', (socket) => socket.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.CMD === 'LOGIN') socket.send(JSON.stringify({ SENDER: 'p', RECEIVER: '', CMD: 'LOGIN_RES', ID: m.ID, PAYLOAD_TYPE: 'USER', PAYLOAD: { RESULT: 'OK', ID_LOGIN: '1' }, TIMESTAMP: '0', CRC_16: '0x0000' }));
        if (m.CMD === 'CMD_USR') socket.close(1001, 'bye');
    }));
    const client = new KseniaWebSocketClient('127.0.0.1', wss.address().port, false, 'hb', '135790', silentLog(), { reconnectInterval: 60_000, heartbeatInterval: 60_000, commandTimeoutMs: 5000 });
    t.after(() => client.disconnect());
    await client.connect();
    // This panel answers only LOGIN: the gate is seeded as discovery would store it.
    seedDevices(client, ['gate_3']);
    const started = Date.now();
    await assert.rejects(() => client.toggleGate('gate_3'), /closed|disconnect/i);
    assert.ok(Date.now() - started < 2000, 'rejected by the close, not by the 5 s command timeout');
});
