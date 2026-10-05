const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function startPanel() {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const sockets = [];
    server.on('connection', (socket) => {
        sockets.push(socket);
        socket.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.CMD === 'LOGIN') {
                socket.send(JSON.stringify({
                    SENDER: 'panel', RECEIVER: '', CMD: 'LOGIN_RES', ID: message.ID,
                    PAYLOAD_TYPE: 'USER', PAYLOAD: { RESULT: 'OK', ID_LOGIN: String(sockets.length) },
                    TIMESTAMP: '0', CRC_16: '0x0000',
                }));
            }
        });
    });
    return new Promise((resolve) => {
        server.on('listening', () => resolve({ server, sockets, port: server.address().port }));
    });
}

test('a late close event from a superseded socket does not tear down the live connection', async () => {
    const { server, sockets, port } = await startPanel();
    const client = new KseniaWebSocketClient('127.0.0.1', port, false, 'hb', '1234', silentLog, {
        heartbeatInterval: 60_000,
        reconnectInterval: 60_000,
    });
    try {
        await client.connect();
        const staleSocket = client['state'].ws;

        // Reconnect (as after a heartbeat timeout) while the old socket is still closing.
        await client['connectionService'].connect();
        assert.notEqual(client['state'].ws, staleSocket);
        assert.equal(client['state'].idLogin, '2');

        const staleClosed = new Promise((resolve) => staleSocket.once('close', resolve));
        sockets[0].terminate();
        await staleClosed;

        assert.equal(client['state'].isConnected, true);
        assert.equal(client['state'].idLogin, '2');
        assert.equal(client['state'].reconnectTimer, undefined);

        // The live socket dropping for real must still trigger a reconnect.
        const liveClosed = new Promise((resolve) => client['state'].ws.once('close', resolve));
        sockets[1].terminate();
        await liveClosed;
        assert.equal(client['state'].isConnected, false);
        assert.notEqual(client['state'].reconnectTimer, undefined);
    } finally {
        client.disconnect();
        await new Promise((resolve) => server.close(resolve));
        for (const socket of sockets) socket.terminate();
    }
});
