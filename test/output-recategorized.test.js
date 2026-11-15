'use strict';

// COMMS-07: the output type memory covers re-reads that do not say what the
// output is (no category, GATE without MOD for a known gate); an explicit
// category always wins. An output reconfigured on the panel from LIGHT to
// GATE stops being a light: its old device leaves the client state and
// follows the prune, the new one appears with its own ID.

const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { OutputTypeMemory } = require('../dist/websocket/output-classifier.js');
const { startMockPanel, DEFAULT_DATA } = require('./fixtures/lares4-mock-panel.js');
const { createPlatform } = require('./fixtures/platform-session-harness.js');
const { waitFor } = require('./fixtures/wait-for.js');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

test('COMMS-07: the type memory keeps a type only for reads that do not name a category', () => {
    const memory = new OutputTypeMemory();
    assert.equal(memory.resolve('5', 'LIGHT', 'B'), 'light');
    assert.equal(memory.resolve('5', '', undefined), 'light', 'no category: the remembered type');
    assert.equal(memory.resolve('5', '   ', undefined), 'light', 'blank category: the remembered type');
    assert.equal(memory.resolve('5', 'GATE', undefined), 'cover', 'explicit GATE: not a light any more');
    assert.equal(memory.resolve('5', 'GATE', 'M'), 'gate');
    assert.equal(memory.resolve('5', 'GATE', undefined), 'gate', 'GATE without MOD for a known gate stays a gate');
    assert.equal(memory.resolve('5', 'ROLL', undefined), 'cover');
    assert.equal(memory.resolve('5', 'GEN', 'M'), undefined);
    assert.equal(memory.resolve('5', '', undefined), undefined, 'an unrecognized category is not forgotten by a blank re-read');
});

test('COMMS-07: two clients do not share the type memory', () => {
    const read = (client, output) => client['messageService'].handleReadResponse({
        CMD: 'READ_RES', ID: '10', SENDER: 'p', RECEIVER: '', TIMESTAMP: '0', CRC_16: '0x0000',
        PAYLOAD_TYPE: 'MULTI_TYPES', PAYLOAD: { RESULT: 'OK', OUTPUTS: [output] },
    });
    const a = new KseniaWebSocketClient('127.0.0.1', 1, false, 'hb', '1234', silentLog, {});
    const b = new KseniaWebSocketClient('127.0.0.1', 1, false, 'hb', '1234', silentLog, {});
    read(a, { ID: '41', DES: 'Gate', CAT: 'GATE', MOD: 'M' });
    // Panel B lists its output 41 without a category: nothing known for it on this client.
    read(b, { ID: '41', DES: 'Unknown' });
    assert.ok(a['state'].devices.has('gate_41'));
    assert.equal([...b['state'].devices.keys()].some((id) => id.endsWith('_41')), false);
});

test('COMMS-07: an output reconfigured from LIGHT to GATE on the panel is no longer a light (sync 1 LIGHT, sync 2 GATE)', async (t) => {
    const panel = await startMockPanel({
        data: { OUTPUTS: [...DEFAULT_DATA.OUTPUTS, { ID: '15', DES: 'Relay', CAT: 'LIGHT', MOD: 'B' }] },
    });
    t.after(() => panel.close());
    const { platform, api, log } = createPlatform(t, { port: panel.port });
    const syncs = () => log.lines.filter((line) => /Initial synchronization completed/.test(line)).length;
    api.emit('didFinishLaunching');
    await waitFor(() => syncs() === 1);
    assert.ok(api.registered.includes('light_15'));

    panel.data.OUTPUTS = [...DEFAULT_DATA.OUTPUTS, { ID: '15', DES: 'Relay', CAT: 'GATE' }];
    panel.dropConnections();
    await waitFor(() => syncs() === 2);

    const devices = platform.wsClient.getAllDevices().map((device) => device.id);
    assert.ok(devices.includes('cover_15'), 'the reconfigured output appears with its new ID');
    assert.equal(devices.includes('light_15'), false, 'the light leaves the client state');
    await waitFor(() => api.registered.includes('cover_15'));

    const before = panel.received.filter((m) => m.PAYLOAD_TYPE === 'CMD_SET_OUTPUT').length;
    await assert.rejects(() => platform.wsClient.switchLight('light_15', true));
    assert.equal(panel.received.filter((m) => m.PAYLOAD_TYPE === 'CMD_SET_OUTPUT').length, before, 'no frame for the old light');
    // The cached light follows the prune of devices no longer listed (3 syncs), like a deleted one.
    assert.ok(log.lines.some((line) => /Relay — absent for 1\/3/.test(line)));
});
