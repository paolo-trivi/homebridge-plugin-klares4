const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Accepts TCP but never answers the WebSocket upgrade: a black-holed panel.
function startSilentServer() {
    const server = net.createServer();
    const sockets = [];
    server.on('connection', (socket) => {
        sockets.push(socket);
        socket.on('error', () => undefined);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, sockets, port: server.address().port }));
    });
}

async function stop(server, sockets) {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
}

async function waitFor(predicate, timeoutMs = 3000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
        await wait(5);
    }
}

function createClient(port, options = {}) {
    const logs = [];
    const log = {
        info: (...args) => logs.push(args.join(' ')),
        warn: (...args) => logs.push(args.join(' ')),
        error: (...args) => logs.push(args.join(' ')),
        debug: () => undefined,
    };
    const client = new KseniaWebSocketClient('127.0.0.1', port, false, 'hb', '1234', log, {
        heartbeatInterval: 60_000,
        ...options,
    });
    return { client, logs };
}

test('F24: shutdown during an in-progress reconnect does not schedule another one', { timeout: 5000 }, async () => {
    const { server, sockets, port } = await startSilentServer();
    const { client } = createClient(port, { reconnectInterval: 10 });
    try {
        client['connectionService'].scheduleReconnect();
        await waitFor(() => sockets.length === 1);
        client.disconnect();
        await wait(100);
        assert.equal(client['state'].reconnectTimer, undefined);
        await wait(100);
        assert.equal(sockets.length, 1);
    } finally {
        client.disconnect();
        await stop(server, sockets);
    }
});

test('F39: a connect whose handshake never completes times out and falls back to the normal backoff', { timeout: 5000 }, async () => {
    const { server, sockets, port } = await startSilentServer();
    const { client, logs } = createClient(port, { connectTimeoutMs: 150, reconnectInterval: 60_000 });
    try {
        const started = Date.now();
        await assert.rejects(() => client.connect(), /timed out|timeout/i);
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 120 && elapsed < 2000, `elapsed ${elapsed}ms`);
        await waitFor(() => client['state'].reconnectTimer !== undefined, 1000);
        assert.ok(logs.some((line) => /Scheduling reconnection attempt 1/.test(line)));
        assert.equal(client['state'].isConnected, false);
    } finally {
        client.disconnect();
        await stop(server, sockets);
    }
});
