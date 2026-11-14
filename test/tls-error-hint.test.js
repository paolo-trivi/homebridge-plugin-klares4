const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { tlsConfigurationHint } = require('../dist/websocket-client/tls-error-hint.js');
const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');

// The exact error reported by a Lares4 panel on Node 24 (issue #37).
const RENEGOTIATION_MESSAGE = 'write EPROTO 409DB28CE17F0000:error:0A000152:SSL routines:final_renegotiate:'
    + 'unsafe legacy renegotiation disabled:../deps/openssl/openssl/ssl/statem/extensions.c:893:';

function renegotiationError() {
    return Object.assign(new Error(RENEGOTIATION_MESSAGE), { code: 'EPROTO' });
}

const STRICT_HTTPS = { useHttps: true, allowInsecureTls: false };

test('legacy renegotiation failure points to allowInsecureTls', () => {
    const hint = tlsConfigurationHint(renegotiationError(), STRICT_HTTPS);
    assert.match(hint, /legacy renegotiation/);
    assert.match(hint, /allowInsecureTls/);
});

test('self-signed certificate failure points to allowInsecureTls', () => {
    const error = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const hint = tlsConfigurationHint(error, STRICT_HTTPS);
    assert.match(hint, /DEPTH_ZERO_SELF_SIGNED_CERT/);
    assert.match(hint, /allowInsecureTls/);
});

test('no hint when allowInsecureTls is already on: the failure is then a real bug', () => {
    assert.equal(tlsConfigurationHint(renegotiationError(), { useHttps: true, allowInsecureTls: true }), undefined);
});

test('no hint over plain ws:// or for unrelated errors', () => {
    assert.equal(tlsConfigurationHint(renegotiationError(), { useHttps: false, allowInsecureTls: false }), undefined);
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
    assert.equal(tlsConfigurationHint(refused, STRICT_HTTPS), undefined);
    assert.equal(tlsConfigurationHint('not an error', STRICT_HTTPS), undefined);
    assert.equal(tlsConfigurationHint(null, STRICT_HTTPS), undefined);
});

test('the client logs the hint once, not on every reconnect', { timeout: 5000 }, async () => {
    // Accepts TCP and never answers: the socket stays CONNECTING until we fail it.
    const sockets = [];
    const server = net.createServer((socket) => {
        sockets.push(socket);
        socket.on('error', () => undefined);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const warnings = [];
    const log = {
        info: () => undefined,
        warn: (...args) => warnings.push(args.join(' ')),
        error: () => undefined,
        debug: () => undefined,
    };
    const client = new KseniaWebSocketClient('127.0.0.1', server.address().port, true, 'hb', '1234', log, {
        heartbeatInterval: 60_000,
        reconnectInterval: 60_000,
    });
    try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const connecting = client.connect();
            client['state'].ws.emit('error', renegotiationError());
            await assert.rejects(connecting, /unsafe legacy renegotiation/);
        }
        const hints = warnings.filter((line) => line.includes('allowInsecureTls'));
        assert.equal(hints.length, 1);
    } finally {
        client.disconnect();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
});
