'use strict';

// WS-03 / TD-T-16: one malformed element or one throwing consumer must not
// cost the rest of the frame, the session, or the process.

const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { startMockPanel, recordingLog } = require('./fixtures/lares4-mock-panel.js');
const { waitFor } = require('./fixtures/wait-for.js');

function makeClient(port, log, options = {}) {
    const client = new KseniaWebSocketClient('127.0.0.1', port, false, 'hb', '135790', log, {
        heartbeatInterval: 60_000, reconnectInterval: 60_000, ...options,
    });
    const events = [];
    client.onDeviceDiscovered = (device) => events.push({ ev: 'discovered', id: device.id });
    client.onDeviceStatusUpdate = (device) => events.push({ ev: 'update', id: device.id, on: device.status.on });
    client.onInitialSyncComplete = () => events.push({ ev: 'sync' });
    return { client, events };
}

async function session(t, options, panelOptions) {
    const panel = await startMockPanel(panelOptions);
    const log = recordingLog();
    const { client, events } = makeClient(panel.port, log, options);
    t.after(async () => {
        client.disconnect();
        await panel.close();
    });
    return { panel, log, client, events };
}

const errors = (log) => log.lines.filter((line) => line.startsWith('[error]'));

test('WS-03 A: a discovery consumer that throws for one device does not hide the others', async (t) => {
    const { log, client, events } = await session(t);
    const inner = client.onDeviceDiscovered;
    client.onDeviceDiscovered = (device) => {
        if (device.id === 'light_6') throw new Error('handler failed for light_6');
        inner(device);
    };
    await client.connect();
    await waitFor(() => events.some((e) => e.ev === 'sync'));

    const discovered = events.filter((e) => e.ev === 'discovered').map((e) => e.id);
    for (const id of ['zone_1', 'light_5', 'cover_7', 'gate_9', 'scenario_1', 'sensor_temp_1', 'sensor_light_1']) {
        assert.ok(discovered.includes(id), `${id} discovered`);
    }
    assert.equal(client['state'].scenarioCategoryById.size, 2, 'every scenario category recorded');
    const [line, ...rest] = errors(log);
    assert.equal(rest.length, 0);
    assert.match(line, /light_6/);
    assert.match(line, /handler failed for light_6/);
    assert.match(line, /\n\s+at /, 'stack trace logged');
    assert.doesNotMatch(line, /Message parsing error/);
});

test('WS-03 B: a status consumer that throws for one device does not drop the rest of the batch', async (t) => {
    const { panel, log, client, events } = await session(t);
    await client.connect();
    await waitFor(() => events.some((e) => e.ev === 'sync'));
    const inner = client.onDeviceStatusUpdate;
    client.onDeviceStatusUpdate = (device) => {
        if (device.id === 'light_5') throw new Error('update failed');
        inner(device);
    };
    events.length = 0;
    panel.realtime({
        STATUS_OUTPUTS: [{ ID: '5', STA: 'ON' }, { ID: '6', STA: 'ON' }],
        STATUS_ZONES: [{ ID: '1', STA: 'A', BYP: 'NO', A: 'N', FM: 'F' }],
    });
    await waitFor(() => events.some((e) => e.id === 'zone_1'));
    assert.deepEqual(events.filter((e) => e.ev === 'update').map((e) => e.id), ['light_6', 'zone_1']);
    assert.equal(errors(log).length, 1);
    assert.match(errors(log)[0], /light_5/);
});

test('WS-03 C: onConnected that throws still completes the login, the heartbeat and the sync', async (t) => {
    const { panel, client, events } = await session(t, { heartbeatInterval: 50 });
    client.onConnected = () => {
        throw new Error('setPanelReachable failed');
    };
    let timer;
    const outcome = await Promise.race([
        client.connect().then(() => 'resolved'),
        new Promise((resolve) => { timer = setTimeout(() => resolve('still pending'), 2_000); }),
    ]);
    clearTimeout(timer);
    assert.equal(outcome, 'resolved');
    assert.equal(client['state'].idLogin, '1');
    assert.notEqual(client['state'].heartbeatTimer, undefined, 'heartbeat started');
    await waitFor(() => events.some((e) => e.ev === 'sync'));
    assert.ok(panel.received.filter((m) => m.CMD === 'READ').length >= 5);
});

test('WS-03 / 13: a raw listener that throws reaches neither the command nor the process', async (t) => {
    const { panel, log, client, events } = await session(t);
    await client.connect();
    await waitFor(() => events.some((e) => e.ev === 'sync'));
    const uncaught = [];
    const onUncaught = (error) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    t.after(() => process.off('uncaughtException', onUncaught));
    client.addRawMessageListener((direction) => {
        throw new Error(`raw listener failed (${direction})`);
    });
    events.length = 0;
    const command = client.switchLight('light_5', true);
    await waitFor(() => panel.received.some((m) => m.CMD === 'CMD_USR'));
    panel.realtime({ STATUS_OUTPUTS: [{ ID: '5', STA: 'ON' }] });
    await command;
    await waitFor(() => events.some((e) => e.id === 'light_5' && e.on === true));
    assert.deepEqual(uncaught, []);
    assert.ok(errors(log).some((line) => /raw listener failed \(in\)/.test(line)));
    assert.ok(errors(log).some((line) => /raw listener failed \(out\)/.test(line)));
});

test('WS-03 / 04-C: a status entry without STA while a command is pending costs no other entry', async (t) => {
    // The panel never answers the command: it stays pending.
    const { panel, log, client, events } = await session(t, { commandTimeoutMs: 2_000 }, {
        onMessage: (message) => message.CMD === 'CMD_USR',
    });
    await client.connect();
    await waitFor(() => events.some((e) => e.ev === 'sync'));
    const pending = client.switchLight('light_5', true).catch(() => undefined);
    await waitFor(() => panel.received.some((m) => m.CMD === 'CMD_USR'));
    events.length = 0;
    panel.realtime({
        STATUS_OUTPUTS: [{ ID: '5' }, { ID: '6', STA: 'ON' }],
        STATUS_ZONES: [{ ID: '1', STA: 'A', BYP: 'NO', A: 'N', FM: 'F' }],
    });
    await waitFor(() => events.some((e) => e.id === 'zone_1'));
    // The other entries are applied. The confirmation matchers read STA
    // defensively (WS-06), so the entry without STA no longer throws in them;
    // whether it may update light_5 is the status parser's call (WS-07).
    const updates = events.filter((e) => e.ev === 'update').map((e) => e.id);
    assert.ok(updates.includes('light_6') && updates.includes('zone_1'), JSON.stringify(updates));
    assert.deepEqual(errors(log).filter((line) => /confirmation|matches/i.test(line)), []);
    let settled = false;
    pending.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'an entry without STA does not confirm the command');
    client.disconnect();
    await pending;
});

test('TD-T-16: malformed frames never throw and a null element costs only itself', () => {
    const log = recordingLog();
    const { client, events } = makeClient(1, log);
    const frames = [
        'null', '[]', '{}', '42', '"x"', 'not json', '{"CMD":"READ_RES"}', '{"CMD":123,"PAYLOAD":{}}',
        '{"CMD":"READ_RES","PAYLOAD_TYPE":"ZONES","PAYLOAD":{"ZONES":[null,{"ID":"1","DES":"Z1"}]}}',
        '{"CMD":"READ_RES","PAYLOAD_TYPE":"MULTI_TYPES","PAYLOAD":{"OUTPUTS":[null,{"ID":"2","DES":"L2","CAT":"LIGHT"}],'
            + '"SCENARIOS":[null,{"ID":"3","DES":"S3","CAT":"GEN"}],"BUS_HAS":[null,{"ID":"4","DES":"D4"}]}}',
        '{"CMD":"REALTIME","PAYLOAD_TYPE":"CHANGES","PAYLOAD":{"hb":{"STATUS_OUTPUTS":[null,{"ID":"2","STA":"ON"}],'
            + '"STATUS_ZONES":[null,{"ID":"1","STA":"A"}]}}}',
        '{"CMD":"REALTIME","PAYLOAD_TYPE":"CHANGES","PAYLOAD":{"hb":{"STATUS_OUTPUTS":{"ID":"2"},"STATUS_ZONES":[{"ID":"1","STA":"R"}]}}}',
    ];
    for (const raw of frames) {
        assert.doesNotThrow(() => client['messageService'].handleMessage(raw), raw);
    }
    const discovered = events.filter((e) => e.ev === 'discovered').map((e) => e.id);
    assert.deepEqual(discovered.sort(), ['light_2', 'scenario_3', 'sensor_hum_4', 'sensor_light_4', 'sensor_temp_4', 'zone_1'].sort());
    const updates = events.filter((e) => e.ev === 'update').map((e) => e.id);
    assert.deepEqual(updates, ['light_2', 'zone_1', 'zone_1']);
    const errorLines = errors(log);
    assert.ok(errorLines.some((l) => /READ_RES\/ZONES/.test(l)), 'frame type in the log');
    assert.ok(errorLines.some((l) => /READ_RES\/MULTI_TYPES/.test(l) && /OUTPUTS/.test(l)));
    assert.ok(errorLines.some((l) => /Invalid JSON/.test(l)), 'parse errors are told apart');
    assert.equal(errorLines.filter((l) => /Message parsing error/.test(l)).length, 0);
});
