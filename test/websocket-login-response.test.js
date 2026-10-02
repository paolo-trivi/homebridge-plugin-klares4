const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');

function createClient() {
    const logs = [];
    const log = {
        info: (...args) => logs.push(['info', args.join(' ')]),
        warn: (...args) => logs.push(['warn', args.join(' ')]),
        error: (...args) => logs.push(['error', args.join(' ')]),
        debug: () => undefined,
    };
    const client = new KseniaWebSocketClient('127.0.0.1', 1, false, 'hb', '1234', log, {});
    const sent = [];
    client['state'].ws = { readyState: 1, close: () => undefined };
    client['wsTransport'].send = async (_ws, raw) => { sent.push(JSON.parse(raw)); };
    return { client, logs, sent };
}

function loginRes(id, result = 'OK') {
    return {
        SENDER: 'panel', RECEIVER: '', CMD: 'LOGIN_RES', ID: id, PAYLOAD_TYPE: 'USER',
        PAYLOAD: { RESULT: result, RESULT_DETAIL: result === 'OK' ? 'LOGIN_OK' : 'LOGIN_KO', ID_LOGIN: '9' },
        TIMESTAMP: '0', CRC_16: '0x0000',
    };
}

function pendLogin(client) {
    const outcome = { resolved: 0, rejected: 0 };
    client['state'].pendingLogin = {
        timeout: setTimeout(() => undefined, 0),
        resolve: () => { outcome.resolved += 1; client['state'].pendingLogin = undefined; },
        reject: () => { outcome.rejected += 1; client['state'].pendingLogin = undefined; },
    };
    return outcome;
}

test('a LOGIN_RES without a pending login is ignored', () => {
    const { client, sent } = createClient();
    try {
        client['messageService'].handleLoginResponse(loginRes('123'));
        assert.equal(client['state'].idLogin, undefined);
        assert.equal(sent.length, 0);
    } finally {
        client.disconnect();
    }
});

test('a LOGIN_RES for another LOGIN ID does not settle the pending login', async () => {
    const { client, sent } = createClient();
    try {
        const outcome = pendLogin(client);
        await client['commandService'].sendLoginCommand();
        const loginId = sent[0].ID;

        client['messageService'].handleLoginResponse(loginRes(String(Number(loginId) + 1)));
        client['messageService'].handleLoginResponse(loginRes(String(Number(loginId) + 2), 'FAIL'));
        assert.deepEqual(outcome, { resolved: 0, rejected: 0 });
        assert.equal(client['state'].idLogin, undefined);

        client['messageService'].handleLoginResponse(loginRes(loginId));
        assert.deepEqual(outcome, { resolved: 1, rejected: 0 });
        assert.equal(client['state'].idLogin, '9');
    } finally {
        client.disconnect();
    }
});
