'use strict';

// WS-06: a state confirmation is a transition observed after the command was
// sent. A state that already matched before the command, or the late realtime
// event of an earlier command on the same output, never confirms; an explicit
// FAIL wins; numbers are compared strictly; a non-string STA does not throw.

const test = require('node:test');
const assert = require('node:assert/strict');

const { OutputCommandConfirmationTracker } = require('../dist/websocket/output-command-confirmation.js');
const { PanelCommandRejectedError, RetryableKlaresError } = require('../dist/errors.js');
const { frame, startMockPanel } = require('./fixtures/lares4-mock-panel.js');
const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { commandClient, pushOutputStatus, settle } = require('./fixtures/command-client.js');

const isOn = (status) => status.STA === 'ON';

test('a state that already matched before the command does not confirm it', async () => {
    const tracker = new OutputCommandConfirmationTracker();
    tracker.observe({ ID: '5', STA: 'ON' });
    const handle = tracker.register('5', 40, isOn);
    tracker.observe({ ID: '5', STA: 'ON' });
    await assert.rejects(handle.promise, /timed out/);
});

test('a transition to the target observed after the command confirms it', async () => {
    const tracker = new OutputCommandConfirmationTracker();
    tracker.observe({ ID: '5', STA: 'OFF' });
    const handle = tracker.register('5', 500, isOn);
    tracker.observe({ ID: '5', STA: 'ON' });
    assert.equal((await handle.promise).status, 'state-confirmed');
});

test('with no state known before the command, a matching state alone does not confirm', async () => {
    const tracker = new OutputCommandConfirmationTracker();
    const handle = tracker.register('5', 500, isOn);
    tracker.observe({ ID: '5', STA: 'ON' });
    let settled = false;
    handle.promise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    tracker.observe({ ID: '5', STA: 'OFF' });
    tracker.observe({ ID: '5', STA: 'ON' });
    assert.equal((await handle.promise).status, 'state-confirmed');
});

test('the late event of an acknowledged earlier command is not taken for the next one', async () => {
    const tracker = new OutputCommandConfirmationTracker();
    tracker.observe({ ID: '5', STA: 'OFF' });
    const first = tracker.register('5', 500, isOn);
    first.promise.catch(() => undefined);
    first.expectLateState(); // ACK arrived, the panel's realtime event is still on its way
    const second = tracker.register('5', 60, isOn);
    tracker.observe({ ID: '5', STA: 'ON' }); // the first command's event
    await assert.rejects(second.promise, /timed out/);
});

test('a non-string STA or ID is tolerated by the tracker and by the client matchers', async () => {
    const tracker = new OutputCommandConfirmationTracker();
    tracker.observe({ ID: '5', STA: 'OFF' });
    const handle = tracker.register('5', 500, isOn);
    assert.doesNotThrow(() => tracker.observe({ ID: 5, STA: null }));
    handle.cancel();

    // The STATUS_OUTPUTS parser is tested elsewhere: here the statuses go straight to the matchers.
    for (const call of [(c) => c.switchLight('light_5', true), (c) => c.dimLight('light_5', 40), (c) => c.moveCover('cover_7', 40)]) {
        const { client, sent } = commandClient({ devices: ['light_5', 'cover_7'], options: { commandTimeoutMs: 60 }, reply: () => undefined });
        const tracker = client['outputConfirmation'];
        tracker.observe({ ID: '5', STA: 'OFF', POS: '0' });
        tracker.observe({ ID: '7', STA: 'STOP', POS: '0', TPOS: '0' });
        const pending = settle(call(client));
        await waitFor(() => sent.length === 1);
        for (const status of [{ ID: '5', STA: 1, POS: null }, { ID: '7', STA: ['UP'], TPOS: '' }, { ID: '5' }, { ID: '7' }, { ID: '5', STA: { v: 'ON' } }]) {
            assert.doesNotThrow(() => tracker.observe(status), JSON.stringify(status));
        }
        const result = await pending;
        assert.equal(result.ok, false);
    }
});

test('client matchers: "", null and spaces are not position 0, a missing STA does not throw', async () => {
    const statuses = [
        { ID: '7', STA: 'STOP', POS: '60', TPOS: '' },
        { ID: '7', STA: 'STOP', POS: null },
        { ID: '7', STA: 'STOP', POS: ' ' },
        { ID: '7', POS: '60' },
    ];
    for (const status of statuses) {
        const harness = commandClient({ devices: ['cover_7'], options: { commandTimeoutMs: 60 }, reply: () => undefined });
        const { client } = harness;
        pushOutputStatus(client, { ID: '7', STA: 'STOP', POS: '60', TPOS: '60' });
        const { sent } = harness;
        const pending = settle(client.moveCover('cover_7', 0));
        await waitFor(() => sent.length === 1);
        pushOutputStatus(client, status);
        const result = await pending;
        assert.equal(result.ok, false, `confirmed by ${JSON.stringify(status)}`);
        assert.ok(result.error instanceof RetryableKlaresError, String(result.error));
    }
    const { client, sent } = commandClient({ devices: ['light_5'], options: { commandTimeoutMs: 60 }, reply: () => undefined });
    pushOutputStatus(client, { ID: '5', STA: 'ON', POS: '40' });
    const dim = settle(client.dimLight('light_5', 0));
    await waitFor(() => sent.length === 1);
    pushOutputStatus(client, { ID: '5', STA: 'ON', POS: '' });
    assert.equal((await dim).ok, false);
});

test('a real transition still confirms a command the panel never acknowledges', async () => {
    const { client, sent } = commandClient({ devices: ['cover_7'], options: { commandTimeoutMs: 2000 }, reply: () => undefined });
    pushOutputStatus(client, { ID: '7', STA: 'STOP', POS: '60', TPOS: '60' });
    const pending = client.moveCover('cover_7', 30);
    await waitFor(() => sent.length === 1);
    pushOutputStatus(client, { ID: '7', STA: 'DOWN', POS: '55', TPOS: '30' });
    await pending;
});

test('repro 04-A: ON / OFF / ON with the first event late and the third refused rejects the third', async (t) => {
    let n = 0;
    const panel = await startMockPanel({ onMessage: (m, socket, p) => {
        if (m.CMD !== 'CMD_USR') return false;
        n += 1;
        if (n === 1) {
            socket.send(frame('CMD_USR_RES', m.ID, 'REPLY', { RESULT: 'OK', RESULT_DETAIL: 'CMD_PROCESSED' }));
            setTimeout(() => p.realtime({ STATUS_OUTPUTS: [{ ID: '5', STA: 'ON' }] }), 60);
        }
        if (n === 2) socket.send(frame('CMD_USR_RES', m.ID, 'REPLY', { RESULT: 'OK', RESULT_DETAIL: 'CMD_PROCESSED' }));
        if (n === 3) setTimeout(() => socket.send(frame('CMD_USR_RES', m.ID, 'REPLY', { RESULT: 'FAIL', RESULT_DETAIL: 'CMD_NOT_AVAILABLE' })), 150);
        return true;
    } });
    const log = { info() {}, warn() {}, error() {}, debug() {}, success() {} };
    const client = new KseniaWebSocketClient('127.0.0.1', panel.port, false, 'hb', '135790', log, {
        commandTimeoutMs: 1000, heartbeatInterval: 60000, reconnectInterval: 60000,
    });
    let synced = false;
    client.onInitialSyncComplete = () => { synced = true; };
    t.after(async () => { client.disconnect(); await panel.close(); });
    await client.connect();
    await waitFor(() => synced);
    await client.switchLight('light_5', true);
    await client.switchLight('light_5', false);
    await assert.rejects(client.switchLight('light_5', true), (error) => error instanceof PanelCommandRejectedError);
});
