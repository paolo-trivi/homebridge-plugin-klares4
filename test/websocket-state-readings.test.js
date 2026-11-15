'use strict';

// WS-07, WS-13, PLAT-13: a reading that is absent, invalid or out of range
// never updates a device and never marks a discovery placeholder as observed;
// zone fields are applied only when present, with the tamper field read.

const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { hasObservedState } = require('../dist/device-observation.js');
const { startMockPanel, recordingLog } = require('./fixtures/lares4-mock-panel.js');
const { waitFor } = require('./fixtures/wait-for.js');

async function session(t, data) {
    const panel = await startMockPanel({ data });
    const log = recordingLog();
    const client = new KseniaWebSocketClient('127.0.0.1', panel.port, false, 'hb', '135790', log, {
        heartbeatInterval: 60_000, reconnectInterval: 60_000,
    });
    const updates = [];
    let synced = false;
    client.onDeviceStatusUpdate = (device) => updates.push({ id: device.id, status: JSON.parse(JSON.stringify(device.status)) });
    client.onInitialSyncComplete = () => { synced = true; };
    t.after(async () => {
        client.disconnect();
        await panel.close();
    });
    await client.connect();
    await waitFor(() => synced);
    const device = (id) => client.getAllDevices().find((d) => d.id === id);
    /**
     * Sends a realtime change, then a marker frame (light_5 OFF), and returns
     * the updates the change emitted once the marker shows it was handled.
     */
    const realtime = async (statusData) => {
        const start = updates.length;
        panel.realtime(statusData);
        panel.realtime({ STATUS_OUTPUTS: [{ ID: '5', STA: 'OFF' }] });
        await waitFor(() => updates.slice(start).some((u) => u.id === 'light_5'));
        return updates.slice(start).filter((u) => u.id !== 'light_5');
    };
    return { panel, log, client, updates, device, realtime };
}

test('WS-07: a DOMUS reading of NA leaves the placeholder unobserved and emits nothing for it', async (t) => {
    const { device, updates } = await session(t, {
        STATUS_BUS_HA_SENSORS: [{ ID: '1', DOMUS: { TEM: 'NA', HUM: '45', LHT: 'NA' } }],
    });
    for (const id of ['sensor_temp_1', 'sensor_light_1']) {
        assert.equal(updates.filter((u) => u.id === id).length, 0, id);
        assert.equal(hasObservedState(device(id)), false, id);
    }
    assert.equal(device('sensor_hum_1').status.value, 45);
    assert.equal(hasObservedState(device('sensor_hum_1')), true);
});

test('WS-13: out-of-range and unreadable sensor values are discarded, numbers are read', async (t) => {
    const { device, realtime } = await session(t);
    const before = { temp: device('sensor_temp_1').status.value, hum: device('sensor_hum_1').status.value, lux: device('sensor_light_1').status.value };
    let emitted = await realtime({ STATUS_BUS_HA_SENSORS: [{ ID: '1', DOMUS: { TEM: '999', HUM: '150', LHT: '-3' } }] });
    assert.deepEqual(emitted.filter((u) => u.id.startsWith('sensor_')), []);
    assert.deepEqual(
        { temp: device('sensor_temp_1').status.value, hum: device('sensor_hum_1').status.value, lux: device('sensor_light_1').status.value },
        before,
    );

    emitted = await realtime({ STATUS_BUS_HA_SENSORS: [{ ID: '1', DOMUS: { TEM: 19.5, HUM: '12abc', LHT: null } }] });
    assert.equal(device('sensor_temp_1').status.value, 19.5, 'a JSON number is a valid reading');
    assert.equal(device('sensor_hum_1').status.value, before.hum);
    assert.deepEqual(emitted.filter((u) => u.id.startsWith('sensor_')).map((u) => u.id), ['sensor_temp_1']);
});

test('WS-13: the system temperature probe discards out-of-range values instead of clamping them', async (t) => {
    const { device, realtime } = await session(t);
    assert.equal(device('sensor_system_temp_out').status.value, 10);
    await realtime({ STATUS_SYSTEM: [{ ID: '1', TEMP: { IN: '22.0', OUT: '-70' } }] });
    assert.equal(device('sensor_system_temp_out').status.value, 10);
});

test('WS-13: an unreadable cover position keeps the last one; STOP without POS is not 50 %', async (t) => {
    const { device, realtime } = await session(t, {
        STATUS_OUTPUTS: [{ ID: '7', STA: 'STOP', POS: '80', TPOS: '80' }],
    });
    assert.equal(device('cover_7').status.position, 80);
    let emitted = await realtime({ STATUS_OUTPUTS: [{ ID: '7', STA: 'STOP', POS: 'abc', TPOS: 'abc' }] });
    assert.equal(device('cover_7').status.position, 80);
    assert.deepEqual(emitted.filter((u) => u.id === 'cover_7'), []);
    emitted = await realtime({ STATUS_OUTPUTS: [{ ID: '7', STA: 'STOP' }] });
    assert.equal(device('cover_7').status.position, 80);
    assert.deepEqual(emitted.filter((u) => u.id === 'cover_7'), []);
    await realtime({ STATUS_OUTPUTS: [{ ID: '7', STA: 'UP', POS: '300', TPOS: '-20' }] });
    assert.equal(device('cover_7').status.position, 80, 'out of range: discarded');
    await realtime({ STATUS_OUTPUTS: [{ ID: '7', STA: 'UP', POS: '30', TPOS: '60' }] });
    assert.deepEqual(device('cover_7').status, { position: 30, targetPosition: 60, state: 'opening' });
});

test('WS-13: light STA is read without case or spacing; an unknown STA changes nothing', async (t) => {
    const { device, realtime } = await session(t);
    await realtime({ STATUS_OUTPUTS: [{ ID: '6', STA: ' on ' }] });
    assert.equal(device('light_6').status.on, true);
    // No STA, a non-string STA or an unknown one: the light keeps its state and nothing is emitted.
    const emitted = await realtime({ STATUS_OUTPUTS: [{ ID: '6' }, { ID: '6', STA: 'BLINK' }, { ID: '6', STA: 1 }] });
    assert.equal(device('light_6').status.on, true);
    assert.deepEqual(emitted.filter((u) => u.id.startsWith('light_')), []);
});

test('WS-13 / PLAT-13: zone fields are applied only when present; T is the tamper flag', async (t) => {
    const { device, realtime, log } = await session(t, {
        STATUS_ZONES: [{ ID: '1', STA: 'A', BYP: 'NO', A: 'N', FM: 'F', T: 'N' }],
    });
    assert.deepEqual(device('zone_1').status, { open: true, bypassed: false, armed: false, fault: false, tampered: false });

    // A partial update (only FM) does not reset the zone to closed.
    await realtime({ STATUS_ZONES: [{ ID: '1', FM: 'T' }] });
    assert.deepEqual(device('zone_1').status, { open: true, bypassed: false, armed: false, fault: true, tampered: false });
    // A zone entry without any readable field emits nothing.
    assert.deepEqual(await realtime({ STATUS_ZONES: [{ ID: '1' }, { ID: '1', STA: 'X' }] }), []);

    await realtime({ STATUS_ZONES: [{ ID: '1', STA: 'A', T: 'Y', BYP: 'MAN' }] });
    const status = device('zone_1').status;
    assert.equal(status.tampered, true);
    assert.equal(status.bypassed, true, 'a BYP value other than NO is read as bypassed');
    assert.ok(log.lines.some((l) => /field T reported "Y"/.test(l)), 'an unseen value is reported once');
    assert.ok(log.lines.some((l) => /field BYP reported "MAN"/.test(l)));
});
