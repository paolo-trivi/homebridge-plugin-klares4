'use strict';

// TD-T-09 (mutations M43, M44, M45) and the connection items of WS-14:
// missing PONG -> reconnection, messages of a superseded socket ignored,
// ws.send errors reject the command, maxPayload, inbound CRC, IPv6 literal,
// shutdown while connecting.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { WebSocketServer } = require('ws');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { panelUrl } = require('../dist/websocket-client/connection-setup.js');
const { startMockPanel, recordingLog, frame } = require('./fixtures/lares4-mock-panel.js');
const { signFrame } = require('./fixtures/panel-frame.js');
const { waitFor } = require('./fixtures/wait-for.js');

function makeClient(t, port, options = {}, host = '127.0.0.1') {
    const log = recordingLog();
    const client = new KseniaWebSocketClient(host, port, false, 'hb', '135790', log, {
        heartbeatInterval: 60_000, reconnectInterval: 60_000, ...options,
    });
    const events = [];
    client.onDeviceStatusUpdate = (device) => events.push({ ev: 'update', id: device.id, status: { ...device.status } });
    client.onInitialSyncComplete = () => events.push({ ev: 'sync' });
    client.onDisconnected = () => events.push({ ev: 'disconnected' });
    t.after(() => client.disconnect());
    return { client, log, events };
}

async function syncedSession(t, options = {}, panelOptions = {}) {
    const panel = await startMockPanel(panelOptions);
    t.after(() => panel.close());
    const session = makeClient(t, panel.port, options);
    await session.client.connect();
    await waitFor(() => session.events.some((e) => e.ev === 'sync'));
    return { panel, ...session };
}

test('M43: a panel that stops answering pings is dropped and the session reconnects', async (t) => {
    const { panel, client, log, events } = await syncedSession(t, { heartbeatInterval: 40, reconnectInterval: 20 });
    // Half-open: the panel's TCP stops reading, so no PONG and no close handshake.
    panel.sockets[0]._socket.pause();
    await waitFor(() => events.some((e) => e.ev === 'disconnected'));
    assert.ok(log.lines.some((l) => /Heartbeat timeout/.test(l)));
    // Reported at once, not when the dead socket finally closes.
    assert.equal(panel.sockets.length, 1, 'disconnected is emitted before the new socket opens');
    await waitFor(() => events.filter((e) => e.ev === 'sync').length === 2);
    assert.equal(client['state'].isConnected, true);
});

test('M44: messages arriving on a superseded socket are ignored', async (t) => {
    const { client, events } = await syncedSession(t);
    const stale = client['state'].ws;
    await client['connectionService'].connect();
    assert.notEqual(client['state'].ws, stale);
    const before = events.length;
    stale.emit('message', Buffer.from(frame('REALTIME', '0', 'CHANGES', { hb: { STATUS_OUTPUTS: [{ ID: '6', STA: 'ON' }] } })));
    client['state'].ws.emit('message', Buffer.from(frame('REALTIME', '0', 'CHANGES', { hb: { STATUS_OUTPUTS: [{ ID: '5', STA: 'ON' }] } })));
    assert.deepEqual(events.slice(before).map((e) => e.id), ['light_5']);
});

test('M45: an error reported by ws.send rejects the command', async (t) => {
    const { client } = await syncedSession(t);
    const ws = client['state'].ws;
    ws.send = (_data, callback) => callback(new Error('socket write failed'));
    await assert.rejects(() => client.switchLight('light_5', true), /socket write failed/);
});

test('WS-14: a frame larger than maxPayload closes the socket instead of being parsed', async (t) => {
    const { panel, events, log } = await syncedSession(t, { maxPayloadBytes: 2048, reconnectInterval: 20 });
    const big = frame('REALTIME', '0', 'CHANGES', {
        hb: { STATUS_OUTPUTS: Array.from({ length: 200 }, (_, i) => ({ ID: String(1000 + i), STA: 'ON' })).concat([{ ID: '6', STA: 'ON' }]) },
    });
    events.length = 0;
    panel.sendRaw(big);
    await waitFor(() => events.some((e) => e.ev === 'disconnected'));
    assert.ok(log.lines.some((l) => /Max payload size exceeded/.test(l)), log.lines.join('\n'));
    await waitFor(() => events.some((e) => e.ev === 'sync'));
    assert.ok(!events.some((e) => e.id === 'light_6' && e.status.on), 'the oversized frame was never applied');
});

test('WS-14: a frame with a wrong CRC is dropped and logged; a signed one is applied', async (t) => {
    const { panel, events, log } = await syncedSession(t);
    // The same frame with a CRC that does not match its content.
    const tampered = frame('REALTIME', '0', 'CHANGES', { hb: { STATUS_OUTPUTS: [{ ID: '6', STA: 'ON' }] } })
        .replace(/"CRC_16":"0x[0-9a-f]{4}"/, '"CRC_16":"0x0000"');
    events.length = 0;
    panel.sendRaw(tampered);
    panel.realtime({ STATUS_OUTPUTS: [{ ID: '5', STA: 'ON' }] });
    await waitFor(() => events.some((e) => e.id === 'light_5'));
    assert.ok(!events.some((e) => e.id === 'light_6'));
    assert.ok(log.lines.some((l) => /^\[error\] .*REALTIME\/CHANGES frame with a wrong CRC_16: dropped/.test(l)));
    // A frame without CRC_16 is still accepted (never seen from a real panel), with one warning.
    panel.sendRaw(JSON.stringify({ CMD: 'REALTIME', ID: '0', PAYLOAD_TYPE: 'CHANGES', PAYLOAD: { hb: { STATUS_OUTPUTS: [{ ID: '6', STA: 'ON' }] } } }));
    await waitFor(() => events.some((e) => e.id === 'light_6'));
    assert.equal(log.lines.filter((l) => /without CRC_16/.test(l)).length, 1);
    assert.equal(signFrame({ CMD: 'X', CRC_16: '0x0000' }).includes('0x0000'), false);
});

test('WS-14: an IPv6 literal is put in brackets in the panel URL', async (t) => {
    assert.equal(panelUrl('fd00::10', 443, true), 'wss://[fd00::10]:443/KseniaWsock/');
    assert.equal(panelUrl('[fd00::10]', 80, false), 'ws://[fd00::10]:80/KseniaWsock/');
    assert.equal(panelUrl('192.0.2.1', 443, true), 'wss://192.0.2.1:443/KseniaWsock/');

    const server = new WebSocketServer({ port: 0, host: '::1' });
    const listening = await new Promise((resolve) => {
        server.once('listening', () => resolve(true));
        server.once('error', () => resolve(false));
    });
    if (!listening) {
        t.skip('no IPv6 loopback on this host');
        return;
    }
    t.after(() => new Promise((resolve) => { for (const c of server.clients) c.terminate(); server.close(resolve); }));
    server.on('connection', (socket) => socket.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.CMD === 'LOGIN') socket.send(frame('LOGIN_RES', m.ID, 'USER', { RESULT: 'OK', ID_LOGIN: '1' }));
    }));
    const { client } = makeClient(t, server.address().port, {}, '::1');
    await client.connect();
    assert.equal(client['state'].idLogin, '1');
});

test('WS-14: a shutdown while connecting is not logged as an error and settles connect()', async (t) => {
    const blackhole = net.createServer((socket) => socket.on('error', () => undefined));
    await new Promise((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => blackhole.close(resolve)));
    const { client, log } = makeClient(t, blackhole.address().port, { reconnectInterval: 20 });
    const connecting = client.connect().then(() => 'resolved', () => 'rejected');
    await new Promise((resolve) => blackhole.once('connection', resolve));
    client.disconnect();
    assert.equal(await connecting, 'rejected');
    assert.deepEqual(log.lines.filter((l) => l.startsWith('[error]')), []);
    assert.equal(client['state'].reconnectTimer, undefined);
});

test('COMMS-03: a non-ASCII frame whose CRC differs is accepted and reported once, with the matching encoding', async (t) => {
    const { crc16OfBytes } = require('../dist/websocket-client/inbound-frame.js');
    const { panel, events, log, client } = await syncedSession(t);
    // A panel that would compute the CRC over latin1 bytes instead of UTF-8.
    const latin1Frame = (statusData) => {
        const unsigned = JSON.stringify({
            SENDER: 'panel', RECEIVER: '', CMD: 'READ_RES', ID: '77', PAYLOAD_TYPE: 'MULTI_TYPES', TIMESTAMP: '0',
            PAYLOAD: { RESULT: 'OK', RESULT_DETAIL: 'READ_OK', ...statusData }, CRC_16: '0x0000',
        });
        const head = unsigned.slice(0, unsigned.lastIndexOf('"CRC_16"') + '"CRC_16"'.length);
        return unsigned.replace('"CRC_16":"0x0000"', `"CRC_16":"${crc16OfBytes(Buffer.from(head, 'latin1'))}"`);
    };
    events.length = 0;
    const outputs = [{ ID: '5', DES: 'Lampada Città', CAT: 'LIGHT', MOD: 'B' }, { ID: '7', DES: 'Shutter', CAT: 'ROLL', MOD: 'BDP' }];
    panel.sendRaw(latin1Frame({ OUTPUTS: outputs }));
    panel.sendRaw(latin1Frame({ OUTPUTS: outputs }));
    panel.realtime({ STATUS_OUTPUTS: [{ ID: '5', STA: 'ON' }] });
    await waitFor(() => events.some((e) => e.id === 'light_5'));
    const reports = log.lines.filter((l) => /non-ASCII text/.test(l));
    assert.equal(reports.length, 1, 'reported once');
    assert.match(reports[0], /matching encoding: latin1/);
    assert.equal(client.getAllDevices().find((d) => d.id === 'light_5').name, 'Lampada Città', 'the frame was applied');
    assert.ok(!log.lines.some((l) => /wrong CRC_16: dropped/.test(l)));

    // The same frame in ASCII with a wrong CRC is corrupted for sure: dropped.
    panel.sendRaw(latin1Frame({ OUTPUTS: [{ ID: '5', DES: 'Lamp', CAT: 'LIGHT', MOD: 'B' }] }).replace(/"CRC_16":"0x[0-9a-f]{4}"/, '"CRC_16":"0x0001"'));
    panel.realtime({ STATUS_OUTPUTS: [{ ID: '5', STA: 'OFF' }] });
    await waitFor(() => log.lines.some((l) => /READ_RES\/MULTI_TYPES frame with a wrong CRC_16: dropped/.test(l)));
});
