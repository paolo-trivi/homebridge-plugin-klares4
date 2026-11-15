'use strict';

// WS-10, COMMS-01: what the login guard counts. A real Lares4 refusal was never
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

test('WS-10: an accepted login without ID_LOGIN fails, is not a PIN refusal, and never uses ID_LOGIN 1', async (t) => {
    const { client } = await session(t, (m, socket) => {
        socket.send(frame('LOGIN_RES', m.ID, 'USER', { RESULT: 'OK' }));
    });
    assert.match(await settle(client.connect()), /without ID_LOGIN/);
    assert.equal(client['state'].idLogin, undefined);
    assert.equal(client['state'].loginRejections, 0);
    assert.ok(client['state'].unansweredLogins >= 1);
});

const pinLines = (log) => log.lines.filter((l) => /check the PIN/.test(l));

test('COMMS-01: a panel restarting (socket closed during the login) reconnects with the normal backoff', async (t) => {
    const { panel, client, log } = await session(t, (m, socket, mock) => {
        if (mock.logins <= 4) socket.terminate();
        else socket.send(frame('LOGIN_RES', m.ID, 'USER', { RESULT: 'OK', ID_LOGIN: '3' }));
    });
    await settle(client.connect());
    await waitFor(() => client['state'].idLogin === '3');
    assert.equal(panel.logins, 5);
    assert.equal(client['state'].reconnectSuspended, false);
    assert.deepEqual(pinLines(log), []);
    assert.equal(client['state'].unansweredLogins, 0, 'a successful login resets both counts');
    assert.equal(client['state'].loginRejections, 0);
});

test('COMMS-01: logins the panel never answers stay in the normal backoff and never blame the PIN', async (t) => {
    const { panel, client, log } = await session(t, () => undefined, { loginTimeoutMs: 30 });
    assert.match(await settle(client.connect()), /Login timeout/);
    await waitFor(() => panel.logins >= 6);
    assert.equal(client['state'].reconnectSuspended, false);
    assert.deepEqual(pinLines(log), []);
    assert.equal(log.lines.filter((l) => /did not answer the last 5 logins/.test(l)).length, 1);
});

test('COMMS-01: refusals interleaved with unanswered logins still reach the slow pace after 3 refusals', async (t) => {
    const { panel, client, log } = await session(t, (m, socket, mock) => {
        if (mock.logins % 2 === 0) socket.terminate();
        else socket.send(frame('LOGIN_RES', m.ID, 'USER', { RESULT: 'FAIL', RESULT_DETAIL: 'LOGIN_KO' }));
    });
    await settle(client.connect());
    await waitFor(() => client['state'].reconnectSuspended);
    assert.equal(panel.logins, 5, 'FAIL, close, FAIL, close, FAIL');
    assert.equal(client['state'].loginRejections, 3);
    assert.equal(pinLines(log).length, 1);
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
