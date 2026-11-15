'use strict';

// WS-12: after a complete discovery read, the devices of the same family that
// the panel no longer lists leave the client state and stop receiving updates.

const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { startMockPanel, recordingLog } = require('./fixtures/lares4-mock-panel.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { signFrame } = require('./fixtures/panel-frame.js');

async function session(t, panelOptions = {}) {
    const panel = await startMockPanel(panelOptions);
    const log = recordingLog();
    const client = new KseniaWebSocketClient('127.0.0.1', panel.port, false, 'hb', '135790', log, {
        heartbeatInterval: 60_000, reconnectInterval: 20,
    });
    const events = [];
    client.onDeviceStatusUpdate = (device) => events.push({ ev: 'update', id: device.id, status: JSON.parse(JSON.stringify(device.status)) });
    client.onInitialSyncComplete = () => events.push({ ev: 'sync' });
    t.after(async () => {
        client.disconnect();
        await panel.close();
    });
    await client.connect();
    await waitFor(() => events.some((e) => e.ev === 'sync'));
    const ids = () => client.getAllDevices().map((d) => d.id).sort();
    const resync = async () => {
        events.length = 0;
        panel.dropConnections();
        await waitFor(() => events.some((e) => e.ev === 'sync'));
    };
    return { panel, log, client, events, ids, resync };
}

test('WS-12: a re-categorised output and removed devices leave the client state', async (t) => {
    const { panel, events, ids, resync, log } = await session(t);
    assert.ok(ids().includes('light_5') && ids().includes('zone_1') && ids().includes('scenario_1'));

    panel.data = {
        ...panel.data,
        ZONES: [],
        OUTPUTS: [{ ID: '5', DES: 'Former Light', CAT: 'ROLL', MOD: 'BDP' }, { ID: '7', DES: 'Shutter', CAT: 'ROLL', MOD: 'BDP' }],
        SCENARIOS: [],
        BUS_HAS: [],
        STATUS_OUTPUTS: [{ ID: '5', STA: 'STOP', POS: '40', TPOS: '40' }, { ID: '7', STA: 'CLOSE', POS: '0', TPOS: '0' }],
        STATUS_ZONES: [],
        STATUS_BUS_HA_SENSORS: [],
    };
    await resync();

    assert.deepEqual(ids(), ['cover_5', 'cover_7', 'sensor_system_temp_in', 'sensor_system_temp_out']);
    const stale = events.filter((e) => e.ev === 'update' && ['light_5', 'light_6', 'gate_9', 'zone_1'].includes(e.id));
    assert.deepEqual(stale, []);
    assert.equal(events.find((e) => e.id === 'cover_5').status.position, 40);
    assert.ok(log.lines.some((l) => /light_5 is no longer listed by the panel/.test(l)));

    // A later status for the old ID is not applied to anything.
    panel.realtime({ STATUS_OUTPUTS: [{ ID: '6', STA: 'ON' }, { ID: '7', STA: 'OPEN', POS: '100', TPOS: '100' }] });
    await waitFor(() => events.some((e) => e.id === 'cover_7' && e.status.position === 100));
    assert.ok(!events.some((e) => e.id === 'light_6'));
});

test('WS-12: a discovery section missing from the read removes nothing', async (t) => {
    const { panel, ids, resync } = await session(t, {
        onMessage: (message, socket, mock) => {
            if (message.CMD !== 'READ' || message.PAYLOAD_TYPE !== 'MULTI_TYPES' || !mock.omitOutputs) return false;
            socket.send(signFrame({
                SENDER: 'panel', RECEIVER: '', CMD: 'READ_RES', ID: message.ID, PAYLOAD_TYPE: 'MULTI_TYPES', TIMESTAMP: '0',
                PAYLOAD: { RESULT: 'OK', RESULT_DETAIL: 'READ_OK', SCENARIOS: mock.data.SCENARIOS, BUS_HAS: mock.data.BUS_HAS },
            }));
            return true;
        },
    });
    const before = ids();
    panel.omitOutputs = true;
    await resync();
    assert.deepEqual(ids(), before);
});

test('COMMS-09: a discovery element that fails is still listed: nothing of that section is removed', async (t) => {
    const { panel, ids, resync, log } = await session(t);
    const before = ids();
    // light_6 and gate_9 are gone, but one element of the section cannot be processed.
    panel.data = { ...panel.data, OUTPUTS: [null, { ID: '5', DES: 'Light A', CAT: 'LIGHT', MOD: 'B' }, { ID: '7', DES: 'Shutter', CAT: 'ROLL', MOD: 'BDP' }] };
    await resync();
    assert.deepEqual(ids(), before);
    assert.ok(log.lines.some((l) => /^\[error\] .*OUTPUTS/.test(l)), 'the element failure is logged by the isolation');
    assert.ok(!log.lines.some((l) => /no longer listed/.test(l)));

    // The next complete section removes what is really gone.
    panel.data = { ...panel.data, OUTPUTS: [{ ID: '5', DES: 'Light A', CAT: 'LIGHT', MOD: 'B' }, { ID: '7', DES: 'Shutter', CAT: 'ROLL', MOD: 'BDP' }] };
    await resync();
    assert.ok(!ids().includes('light_6') && !ids().includes('gate_9'));
});

test('N-ws2: a ZONES read with a malformed element (null, not an object, no ID) keeps every zone', async (t) => {
    for (const malformed of [null, 5, 'x', { DES: 'no id' }]) {
        const { panel, ids, resync, log, client } = await session(t, {
            data: { ZONES: [{ ID: '1', DES: 'Zone One' }, { ID: '2', DES: 'Zone Two' }, { ID: '3', DES: 'Zone Three' }] },
        });
        const before = ids();
        // Zone 3 is gone, but one element cannot be read: nothing of the family is removed.
        panel.data = { ...panel.data, ZONES: [malformed, { ID: '1', DES: 'Zone One' }, { ID: '2', DES: 'Zone Two Renamed' }] };
        await resync();
        assert.deepEqual(ids(), before, JSON.stringify(malformed));
        assert.ok(!ids().includes('zone_undefined'));
        assert.ok(log.lines.some((l) => /^\[error\] READ_RES\/ZONES zone \? failed: Error: not an object with an ID/.test(l)), JSON.stringify(malformed));
        assert.ok(!log.lines.some((l) => /no longer listed/.test(l)));
        // The valid elements are still applied.
        assert.equal(client.getAllDevices().find((d) => d.id === 'zone_2').name, 'Zone Two Renamed');
    }
});

test('an output re-read without a category keeps the type the exposure policy remembered (explicit type to the parser)', async (t) => {
    const { panel, ids, resync } = await session(t);
    assert.ok(ids().includes('cover_7'));
    panel.data = { ...panel.data, OUTPUTS: panel.data.OUTPUTS.map((o) => (o.ID === '7' ? { ...o, CAT: '' } : o)) };
    await resync();
    assert.ok(ids().includes('cover_7'), ids().join(','));
    assert.ok(!ids().includes('light_7'));
});
