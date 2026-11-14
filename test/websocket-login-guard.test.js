'use strict';

// WS-10: what the login guard counts. A real Lares4 refusal was never
// captured, so each observable shape is covered: a refusal with another ID,
// a RESULT in another case, an OK without ID_LOGIN, the socket closed during
// the login, a login never answered. WS-14: connect() always settles.

const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { startMockPanel, recordingLog, frame } = require('./fixtures/lares4-mock-panel.js');
const { waitFor } = require('./fixtures/wait-for.js');

/** `answer(message, socket, panel)` replaces the panel's LOGIN_RES. */
async function session(t, answer, options = {}) {
    const panel = await startMockPanel({
        onMessage: (m, socket, mock) => {
            if (m.CMD !== 'LOGIN') return false;
            mock.logins += 1;
            answer(m, socket, mock);
            return true;
        },
    });
    const log = recordingLog();
    const client = new KseniaWebSocketClient('127.0.0.1', panel.port, false, 'hb', '135790', log, {
        heartbeatInterval: 60_000, reconnectInterval: 10, suspendedLoginRetryMs: 60_000, ...options,
    });
    t.after(async () => {
        client.disconnect();
        await panel.close();
    });
    return { panel, log, client };
}

const settle = (promise) => promise.then(() => 'resolved', (error) => `rejected: ${error.message}`);

test('WS-10: a refusal carrying another ID counts, and three of them slow reconnection down', async (t) => {
    const { panel, client } = await session(t, (_m, socket) => {
        socket.send(frame('LOGIN_RES', '0', 'USER', { RESULT: 'FAIL', RESULT_DETAIL: 'LOGIN_KO' }));
    });
    assert.match(await settle(client.connect()), /rejected: Login failed: LOGIN_KO/);
    await waitFor(() => client['state'].reconnectSuspended);
    assert.equal(panel.logins, 3);
    assert.equal(client['state'].loginRejections, 3);
});

test('WS-10: RESULT is normalized like everywhere else', async (t) => {
    for (const result of ['ok', ' OK ']) {
        const { client } = await session(t, (m, socket) => {
            socket.send(frame('LOGIN_RES', m.ID, 'USER', { RESULT: result, ID_LOGIN: '7' }));
        });
        assert.equal(await settle(client.connect()), 'resolved', JSON.stringify(result));
        assert.equal(client['state'].idLogin, '7');
        assert.equal(client['state'].loginRejections, 0);
        client.disconnect();
    }
});

test('WS-10: an accepted login without ID_LOGIN is a failed login, never ID_LOGIN 1', async (t) => {
    const { client } = await session(t, (m, socket) => {
        socket.send(frame('LOGIN_RES', m.ID, 'USER', { RESULT: 'OK' }));
    });
    assert.match(await settle(client.connect()), /without ID_LOGIN/);
    assert.equal(client['state'].idLogin, undefined);
    assert.ok(client['state'].loginRejections >= 1);
});

test('WS-10: a socket closed by the panel during the login counts as a failed login', async (t) => {
    const { panel, client } = await session(t, (_m, socket) => socket.terminate());
    assert.match(await settle(client.connect()), /rejected/);
    await waitFor(() => client['state'].reconnectSuspended);
    assert.equal(panel.logins, 3);
});

test('WS-10: logins the panel never answers count too', async (t) => {
    const { panel, client } = await session(t, () => undefined, { loginTimeoutMs: 50 });
    assert.match(await settle(client.connect()), /Login timeout/);
    await waitFor(() => client['state'].reconnectSuspended);
    assert.equal(panel.logins, 3);
});

test('WS-14: disconnect() during the login settles connect() and counts nothing', async (t) => {
    const { panel, client } = await session(t, () => undefined);
    const connecting = settle(client.connect());
    await waitFor(() => panel.logins === 1);
    client.disconnect();
    assert.match(await connecting, /rejected: Client disconnected/);
    assert.equal(client['state'].loginRejections, 0);
    assert.equal(client['state'].reconnectTimer, undefined);
});
