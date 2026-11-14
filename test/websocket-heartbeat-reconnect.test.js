const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');

// F42 (seen on a real panel): after an outage, the heartbeat timer of the dead
// socket kept its stale state and killed the fresh session before its LOGIN_RES.
function startPanel(loginDelayMs) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const sockets = [];
    server.on('connection', (socket) => {
        sockets.push(socket);
        socket.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.CMD !== 'LOGIN') return;
            setTimeout(() => socket.send(JSON.stringify({
                SENDER: 'panel', RECEIVER: '', CMD: 'LOGIN_RES', ID: message.ID,
                PAYLOAD_TYPE: 'USER', PAYLOAD: { RESULT: 'OK', ID_LOGIN: '2' },
                TIMESTAMP: '0', CRC_16: '0x0000',
            })), sockets.length > 1 ? loginDelayMs : 0);
        });
    });
    return new Promise((resolve) => server.on('listening', () => resolve({ server, sockets, port: server.address().port })));
}

test('F42: a stale heartbeat from before an outage does not kill the reconnected session', async () => {
    const { server, sockets, port } = await startPanel(300);
    const warnings = [];
    const log = { info() {}, error() {}, debug() {}, warn: (m) => warnings.push(String(m)) };
    const client = new KseniaWebSocketClient('127.0.0.1', port, false, 'hb', '1234', log, {
        heartbeatInterval: 50,
        reconnectInterval: 60_000,
    });
    try {
        await client.connect();
        // State left by an outage: a ping went unanswered long ago.
        client['state'].heartbeatPending = true;
        client['state'].lastPongReceived = Date.now() - 10 * 60_000;
        const closed = new Promise((resolve) => client['state'].ws.once('close', resolve));
        sockets[0].terminate(); // the panel drops the socket
        await closed;

        await client['connectionService'].connect(); // reconnect; LOGIN_RES arrives after 300 ms
        await new Promise((resolve) => setTimeout(resolve, 150));

        assert.deepEqual(warnings.filter((w) => w.includes('Heartbeat timeout')), []);
        assert.equal(sockets.length, 2, 'no extra reconnection');
        assert.equal(client['state'].isConnected, true);
        assert.equal(client['state'].idLogin, '2');
    } finally {
        client.disconnect();
        await new Promise((resolve) => server.close(resolve));
        for (const socket of sockets) socket.terminate();
    }
});
