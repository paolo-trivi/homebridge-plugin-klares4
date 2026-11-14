'use strict';

// Effects of task C's connection and parsing changes on the other subsystems:
// the login guard with the MQTT panel status (H), removed devices with the
// command queue (B), out-of-range readings with the thermostat pipeline (D).

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { startMockPanel, recordingLog, frame } = require('./fixtures/lares4-mock-panel.js');
const { createPlatform } = require('./fixtures/platform-session-harness.js');
const { startFakeBroker } = require('./fixtures/fake-mqtt-broker.js');
const { signFrame } = require('./fixtures/panel-frame.js');
const { realisticCfg, silentLog } = require('./fixtures/thermostat-panel');
const { waitFor } = require('./fixtures/wait-for.js');

const STATUS = 'homebridge/klares4/status';

test('WS-10 + SP-11: after three refused logins the panel stays disconnected on MQTT', { timeout: 20000 }, async (t) => {
    const broker = await startFakeBroker(t);
    const panel = await startMockPanel({
        onMessage: (m, socket, mock) => {
            if (m.CMD !== 'LOGIN') return false;
            mock.logins += 1;
            socket.send(frame('LOGIN_RES', m.ID, 'USER', { RESULT: 'FAIL', RESULT_DETAIL: 'LOGIN_KO' }));
            return true;
        },
    });
    t.after(() => panel.close());
    const { platform, api, log } = createPlatform(t, { port: panel.port, config: { mqtt: { enabled: true, broker: broker.url } } });
    api.emit('didFinishLaunching');
    await waitFor(() => platform.wsClient?.['state'].reconnectSuspended === true, 15000);
    assert.equal(panel.logins, 3);
    const states = broker.published(STATUS).filter((s) => s.state === 'online').map((s) => s.panel);
    assert.ok(states.length > 0);
    assert.ok(!states.includes('connected'), JSON.stringify(states));
    assert.equal(states.at(-1), 'disconnected');
    assert.ok(log.lines.some((l) => /refused or did not answer the login 3 times/.test(l)));
});

test('WS-12 + command queue: a command to a device the panel no longer lists is refused, nothing is sent', async (t) => {
    const panel = await startMockPanel();
    t.after(() => panel.close());
    const client = new KseniaWebSocketClient('127.0.0.1', panel.port, false, 'hb', '135790', recordingLog(), {
        heartbeatInterval: 60_000, reconnectInterval: 20,
    });
    let syncs = 0;
    client.onInitialSyncComplete = () => { syncs += 1; };
    t.after(() => client.disconnect());
    await client.connect();
    await waitFor(() => syncs === 1);
    panel.data = { ...panel.data, OUTPUTS: panel.data.OUTPUTS.filter((o) => o.ID !== '6') };
    panel.dropConnections();
    await waitFor(() => syncs === 2);
    assert.equal(client.getAllDevices().some((d) => d.id === 'light_6'), false);
    await assert.rejects(() => client.switchLight('light_6', true));
    assert.equal(panel.received.filter((m) => m.PAYLOAD_TYPE === 'CMD_SET_OUTPUT').length, 0);
});

test('WS-13 + thermostats: out-of-range realtime and cfg values leave the thermostat as it was', () => {
    const c = new KseniaWebSocketClient('127.0.0.1', 443, true, 'x', '000000', silentLog(), {});
    const msg = (CMD, PAYLOAD_TYPE, PAYLOAD) => c['messageService'].handleMessage(signFrame({
        SENDER: 'p', RECEIVER: 'x', CMD, ID: '1', PAYLOAD_TYPE, PAYLOAD, TIMESTAMP: '0',
    }));
    const rt = (val, temp) => msg('REALTIME', 'CHANGES', {
        x: { STATUS_TEMPERATURES: [{ ID: '1', TEMP: temp, THERM: { ACT_SEA: 'WIN', ACT_MODEL: 'MAN', ACT_TOF: '', TEMP_THR: { T: 'M', VAL: val }, OUT_STATUS: 'OFF' } }] },
    });
    msg('READ_RES', 'MULTI_TYPES', {
        RESULT: 'OK', OUTPUTS: [{ ID: '18', DES: 'Heating Room', CAT: 'THERMO', MOD: 'C' }], BUS_HAS: [{ ID: '1', DES: 'Room' }], SCENARIOS: [],
    });
    msg('READ_RES', 'PRG_THERMOSTATS', {
        RESULT: 'OK', PRG_THERMOSTATS: [{ ID: '1', DES: 'Room', PERIPH: { PID: '1' }, HEATING_OUT: '18', COOLING_OUT: 'NU' }],
    });
    rt('21.0', '19.5');
    const device = () => c['state'].devices.get('thermostat_18');
    assert.equal(device().status.currentTemperature, 19.5);

    rt('99.0', '250.0');
    assert.equal(device().status.currentTemperature, 19.5, 'a 250 °C reading is a fault, not a temperature');
    assert.equal(device().status.targetTemperature, 21, 'a 99 °C setpoint is outside 5..40 and is discarded');
    msg('READ_RES', 'CFG_THERMOSTATS', { RESULT: 'OK', CFG_THERMOSTATS: [realisticCfg('1', { mode: 'MAN', winTm: '80.0' })] });
    assert.equal(device().status.targetTemperature, 21);
    msg('REALTIME', 'CHANGES', { x: { STATUS_SYSTEM: [{ ID: '1', TEMP: { IN: '-70', OUT: '120' } }] } });
    assert.equal(device().status.currentTemperature, 19.5);
});

// Hooks left by task D on the client facade (changes/D.md).
function thermostatClient() {
    const c = new KseniaWebSocketClient('127.0.0.1', 443, true, 'x', '000000', silentLog(), {});
    const msg = (CMD, PAYLOAD_TYPE, PAYLOAD) => c['messageService'].handleMessage(signFrame({
        SENDER: 'p', RECEIVER: 'x', CMD, ID: '1', PAYLOAD_TYPE, PAYLOAD, TIMESTAMP: '0',
    }));
    msg('READ_RES', 'MULTI_TYPES', {
        RESULT: 'OK', OUTPUTS: [{ ID: '18', DES: 'Heating Room', CAT: 'THERMO', MOD: 'C' }], BUS_HAS: [], SCENARIOS: [],
    });
    return { c, msg, state: c['state'] };
}

test('D hook: PRG_CHECK of the cfg read is the baseline; NM_CHANGES through the client drops a foreign change', () => {
    const { msg, state } = thermostatClient();
    msg('READ_RES', 'CFG_THERMOSTATS', {
        RESULT: 'OK', CFG_THERMOSTATS: [realisticCfg('1', { mode: 'MAN', winTm: '21.0' })], PRG_CHECK: { CFG: '0000000100' },
    });
    assert.equal(state.thermostatCfgById.has('1'), true);
    msg('NOT_MASK_UNSOLICITED', 'NM_CHANGES', { PRG_CHECK: { CFG: '0000000100' } });
    assert.equal(state.thermostatCfgById.has('1'), true, 'same counter as the read: nothing changed');
    msg('NOT_MASK_UNSOLICITED', 'NM_CHANGES', { PRG_CHECK: { CFG: '0000000101' } });
    assert.equal(state.thermostatCfgById.size, 0, 'changed elsewhere: the cfg cache is dropped');
});

test('D hook: an unknown legacy MODE in STATUS_OUTPUTS leaves the thermostat mode as it was', () => {
    const { msg, state } = thermostatClient();
    msg('REALTIME', 'CHANGES', { x: { STATUS_OUTPUTS: [{ ID: '18', STA: 'ON', MODE: '1' }] } });
    assert.equal(state.devices.get('thermostat_18').status.mode, 'heat');
    msg('REALTIME', 'CHANGES', { x: { STATUS_OUTPUTS: [{ ID: '18', STA: 'ON', MODE: 'TIMED' }] } });
    assert.equal(state.devices.get('thermostat_18').status.mode, 'heat');
});

test('D hook: the command service publishes thermostat state through the client events', () => {
    const { c, state } = thermostatClient();
    const updates = [];
    c.onDeviceStatusUpdate = (device) => updates.push(device.id);
    c['commandService'].deps.emitDeviceStatusUpdate(state.devices.get('thermostat_18'));
    assert.deepEqual(updates, ['thermostat_18']);
});
