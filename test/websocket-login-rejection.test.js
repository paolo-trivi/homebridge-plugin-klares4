const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { signFrame } = require('./fixtures/panel-frame.js');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');

// Local panel that answers each LOGIN with the next scripted result.
function startPanel(results) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const sockets = [];
    let logins = 0;
    server.on('connection', (socket) => {
        sockets.push(socket);
        socket.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.CMD !== 'LOGIN') return;
            const result = results[Math.min(logins, results.length - 1)];
            logins += 1;
            socket.send(signFrame({
                SENDER: 'panel', RECEIVER: '', CMD: 'LOGIN_RES', ID: message.ID, PAYLOAD_TYPE: 'USER',
                PAYLOAD: result === 'OK'
                    ? { RESULT: 'OK', RESULT_DETAIL: 'LOGIN_OK', ID_LOGIN: '4' }
                    : { RESULT: 'FAIL', RESULT_DETAIL: 'LOGIN_KO' },
                TIMESTAMP: '0', CRC_16: '0x0000',
            }));
        });
    });
    return new Promise((resolve) => {
        server.on('listening', () => resolve({
            server, sockets, port: server.address().port, logins: () => logins,
        }));
    });
}

function createClient(port, options = {}) {
    const errors = [];
    const log = { info() {}, warn() {}, debug() {}, error: (...args) => errors.push(args.join(' ')) };
    const client = new KseniaWebSocketClient('127.0.0.1', port, false, 'hb', '1234', log, {
        reconnectInterval: 10,
        heartbeatInterval: 60_000,
        ...options,
    });
    return { client, errors };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
        await wait(10);
    }
}

// WS-10: past the limit reconnection slows down instead of stopping for good;
// each further failure repeats the remedy in the log.
test('three rejected logins in a row slow reconnection down to the suspended pace', async () => {
    const panel = await startPanel(['FAIL']);
    const { client, errors } = createClient(panel.port, { suspendedLoginRetryMs: 400 });
    try {
        await assert.rejects(() => client.connect(), /Login failed/);
        await waitFor(() => client['state'].reconnectSuspended && client['state'].reconnectTimer !== undefined);
        const suspendedAt = Date.now();
        assert.equal(panel.logins(), 3);
        assert.equal(errors.filter((line) => /PIN/.test(line) && /restart/i.test(line)).length, 1, errors.join('\n'));
        await waitFor(() => panel.logins() === 4);
        assert.ok(Date.now() - suspendedAt >= 300, 'the next login waits for the suspended pace, not the 10 ms backoff');
        await waitFor(() => errors.filter((line) => /PIN/.test(line) && /restart/i.test(line)).length === 2);
        assert.ok(errors.every((line) => !line.includes('1234')));
    } finally {
        client.disconnect();
        await new Promise((resolve) => panel.server.close(resolve));
        for (const socket of panel.sockets) socket.terminate();
    }
});

test('a successful login resets the rejection count', async () => {
    const panel = await startPanel(['FAIL', 'FAIL', 'OK']);
    const { client } = createClient(panel.port);
    try {
        await assert.rejects(() => client.connect(), /Login failed/);
        await waitFor(() => client['state'].idLogin === '4');
        assert.equal(client['state'].loginRejections, 0);
        assert.equal(client['state'].reconnectSuspended, false);
    } finally {
        client.disconnect();
        await new Promise((resolve) => panel.server.close(resolve));
        for (const socket of panel.sockets) socket.terminate();
    }
});
