'use strict';

// WS-04 end to end (repro 05): a slow panel, a gate pressed three times and a
// light switched ON / OFF / ON. Only what is still wanted reaches the panel.

const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { CommandQueueRejectedError } = require('../dist/websocket/command-dispatcher.js');
const { frame, startMockPanel, recordingLog } = require('./fixtures/lares4-mock-panel.js');
const { PanelCommandRejectedError } = require('../dist/errors.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { settle } = require('./fixtures/command-client.js');

const silent = { info() {}, warn() {}, error() {}, debug() {}, success() {} };

async function session(t, onCommand, commandTimeoutMs, log = silent) {
    const panel = await startMockPanel({ onMessage: (m, socket) => {
        if (m.CMD !== 'CMD_USR') return false;
        onCommand(m, socket);
        return true;
    } });
    const client = new KseniaWebSocketClient('127.0.0.1', panel.port, false, 'hb', '135790', log, {
        commandTimeoutMs, heartbeatInterval: 60000, reconnectInterval: 60000,
    });
    let synced = false;
    client.onInitialSyncComplete = () => { synced = true; };
    t.after(async () => { client.disconnect(); await panel.close(); });
    await client.connect();
    await waitFor(() => synced);
    const commands = () => panel.received.filter((m) => m.CMD === 'CMD_USR');
    return { client, commands };
}

test('repro 05-A: three gate presses while the panel is slow send one pulse, not three', async (t) => {
    const T = 150;
    const { client, commands } = await session(t, (m, socket) => {
        setTimeout(() => socket.send(frame('CMD_USR_RES', m.ID, 'REPLY', { RESULT: 'OK', RESULT_DETAIL: 'CMD_PROCESSED' })), T + 50);
    }, T);
    const results = await Promise.all([1, 2, 3].map(() => settle(client.toggleGate('gate_9'))));
    assert.match(results[0].error.message, /timed out/);
    for (const later of results.slice(1)) {
        assert.ok(later.error instanceof CommandQueueRejectedError && later.error.reason === 'busy', String(later.error));
    }
    await new Promise((resolve) => setTimeout(resolve, T));
    assert.equal(commands().length, 1);
});

test('light ON / OFF / ON while the first is unanswered: the replaced OFF is never sent and follows the last ON', async (t) => {
    const replies = [];
    const { client, commands } = await session(t, (m, socket) => {
        replies.push(() => socket.send(frame('CMD_USR_RES', m.ID, 'REPLY', { RESULT: 'OK', RESULT_DETAIL: 'CMD_PROCESSED' })));
    }, 2000);
    const on = client.switchLight('light_5', true);
    const off = client.switchLight('light_5', false);
    const onAgain = client.switchLight('light_5', true);
    await waitFor(() => replies.length === 1);
    replies[0]();
    await on;
    await waitFor(() => replies.length === 2);
    replies[1]();
    await Promise.all([off, onAgain]);
    assert.deepEqual(commands().map((m) => m.PAYLOAD.OUTPUT.STA), ['ON', 'ON']);
});

/** A slider dragged across ten values while the first write waits for its ACK. */
async function dimmerBurst(t, lastResult) {
    const replies = [];
    const log = recordingLog();
    const { client, commands } = await session(t, (m, socket) => {
        replies.push((result) => socket.send(frame('CMD_USR_RES', m.ID, 'REPLY', { RESULT: result, RESULT_DETAIL: 'X' })));
    }, 5000, log);
    const settled = [];
    const requests = Array.from({ length: 10 }, (_, i) => {
        const request = settle(client.dimLight('light_5', (i + 1) * 10));
        request.then(() => settled.push(i));
        return request;
    });
    await waitFor(() => replies.length === 1);
    replies[0]('OK');
    await waitFor(() => replies.length === 2);
    assert.deepEqual(settled, [0], 'replaced requests wait for the final command');
    replies[1](lastResult);
    const results = await Promise.all(requests);
    assert.deepEqual(commands().map((m) => m.PAYLOAD.OUTPUT.STA), ['10', '100']);
    assert.deepEqual(log.lines.filter((line) => line.startsWith('[error]')), []);
    return { results, settled };
}

test('COMMS-04: ten dimmer writes send one final frame and all settle with its ACK, no error logged', async (t) => {
    const { results, settled } = await dimmerBurst(t, 'OK');
    assert.deepEqual(results.map((r) => r.ok), Array(10).fill(true));
    // Oldest first, the write really sent last: a cache updated by each caller ends at 100.
    assert.deepEqual(settled, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('COMMS-04: when the panel refuses the final write, the replaced requests fail with it', async (t) => {
    const { results } = await dimmerBurst(t, 'FAIL');
    assert.equal(results[0].ok, true, 'the first write was acknowledged');
    for (const result of results.slice(1)) {
        assert.ok(result.error instanceof PanelCommandRejectedError, String(result.error));
    }
});
