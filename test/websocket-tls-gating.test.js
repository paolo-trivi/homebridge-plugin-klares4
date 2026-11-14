'use strict';

// Invariant 8: TLS without verification only with allowInsecureTls === true.
// A local wss panel with a self-signed certificate generated at runtime stands
// in for the Lares4 panel. TD-T-01 (mutations M04, M05, M56, M57).

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { WebSocketServer } = require('ws');
const { signFrame } = require('./fixtures/panel-frame.js');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { createSelfSignedCertificate } = require('./fixtures/self-signed-cert.js');

const SYNTHETIC_PIN = '135790';
const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });

function startTlsPanel(t) {
    const server = https.createServer(createSelfSignedCertificate());
    const wss = new WebSocketServer({ server });
    const frames = [];
    wss.on('connection', (socket) => socket.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        frames.push(m);
        if (m.CMD === 'LOGIN') {
            socket.send(signFrame({ SENDER: 'p', RECEIVER: '', CMD: 'LOGIN_RES', ID: m.ID, PAYLOAD_TYPE: 'USER', PAYLOAD: { RESULT: 'OK', RESULT_DETAIL: 'LOGIN_OK', ID_LOGIN: '1' }, TIMESTAMP: '0', CRC_16: '0x0000' }));
        }
    }));
    t.after(() => new Promise((resolve) => { for (const c of wss.clients) c.terminate(); wss.close(() => server.close(resolve)); }));
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ frames, port: server.address().port })));
}

test('without allowInsecureTls a self-signed panel certificate is rejected and no LOGIN is sent', { timeout: 10000 }, async (t) => {
    const panel = await startTlsPanel(t);
    const client = new KseniaWebSocketClient('127.0.0.1', panel.port, true, 'hb', SYNTHETIC_PIN, silentLog(), { reconnectInterval: 60_000, heartbeatInterval: 60_000 });
    t.after(() => client.disconnect());
    await assert.rejects(() => client.connect(), /self.signed|DEPTH_ZERO_SELF_SIGNED_CERT|certificate/i);
    assert.equal(panel.frames.length, 0, 'no LOGIN (PIN) may be sent over an unverified TLS session');
});

test('with allowInsecureTls the same panel is accepted (the gate is the only difference)', { timeout: 10000 }, async (t) => {
    const panel = await startTlsPanel(t);
    const client = new KseniaWebSocketClient('127.0.0.1', panel.port, true, 'hb', SYNTHETIC_PIN, silentLog(), { allowInsecureTls: true, reconnectInterval: 60_000, heartbeatInterval: 60_000 });
    t.after(() => client.disconnect());
    await client.connect();
    assert.equal(panel.frames[0].CMD, 'LOGIN');
});

test('a client built without options hides PARTIAL scenarios and verifies TLS', () => {
    const client = new KseniaWebSocketClient('127.0.0.1', 1, true, 'hb', SYNTHETIC_PIN, silentLog());
    assert.equal(client['options'].exposePartialArmScenarios, false);
    assert.equal(client['options'].allowInsecureTls, false);
});
