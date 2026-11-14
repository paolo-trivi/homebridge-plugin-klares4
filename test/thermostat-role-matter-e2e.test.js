'use strict';

// TH-05 / invariant 3, end to end: the output role comes from the panel's
// PRG_THERMOSTATS (or the .ksa cache) through the WebSocket client's state,
// and drives the Matter thermostat on the real Homebridge stack; the panel's
// cooling-sounding output name does not.
const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { signFrame } = require('./fixtures/panel-frame.js');
const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');
const { silentLog } = require('./fixtures/thermostat-panel');

// Heating output 18 carries a name that the 2.2.0 heuristic reads as "cooling".
const OUTPUTS = [
    { ID: '18', DES: 'Raffrescamento Room', CAT: 'THERMO', MOD: 'C' },
    { ID: '34', DES: 'Room Cooler', CAT: 'THERMO', MOD: 'C' },
];
const PROGRAM = { ID: '1', DES: 'Room', PERIPH: { PID: '1' }, HEATING_OUT: '18', COOLING_OUT: '34' };

function panelClient(options = {}) {
    const client = new KseniaWebSocketClient('127.0.0.1', 443, true, 'x', '000000', silentLog(), options);
    const discovered = new Map();
    client.onDeviceDiscovered = (device) => discovered.set(device.id, { ...device, status: { ...device.status } });
    const msg = (CMD, PAYLOAD_TYPE, PAYLOAD) => client.messageService.handleMessage(signFrame({
        SENDER: 'p', RECEIVER: 'x', CMD, ID: '1', PAYLOAD_TYPE, PAYLOAD, TIMESTAMP: '0',
    }));
    const multi = () => msg('READ_RES', 'MULTI_TYPES', { RESULT: 'OK', OUTPUTS, BUS_HAS: [{ ID: '1', DES: 'Room' }], SCENARIOS: [] });
    const prg = () => msg('READ_RES', 'PRG_THERMOSTATS', { RESULT: 'OK', PRG_THERMOSTATS: [PROGRAM] });
    const summer = () => msg('REALTIME', 'CHANGES', { x: { STATUS_TEMPERATURES: [{
        ID: '1', TEMP: '27.0', THERM: { ACT_SEA: 'SUM', ACT_MODEL: 'MAN', ACT_TOF: '', TEMP_THR: { T: 'M', VAL: '26.0' }, OUT_STATUS: 'ON' },
    }] } });
    return { client, discovered, multi, prg, summer, device: (id) => client.state.devices.get(id) };
}

function stubPanel() {
    const calls = [];
    return {
        calls,
        async setThermostatTemperature(id, value) { calls.push(['temp', id, value]); },
        async setThermostatMode(id, mode) { calls.push(['mode', id, mode]); },
    };
}

test('PRG_THERMOSTATS role reaches the client state; the panel name does not decide it', () => {
    const h = panelClient();
    h.multi();
    assert.equal(h.device('thermostat_18').status.outputRole, 'heating-cooling', 'before the programs: panel-name fallback (2.2.0)');
    h.prg();
    h.summer();
    assert.equal(h.device('thermostat_18').status.outputRole, 'heating');
    assert.equal(h.device('thermostat_34').status.outputRole, 'cooling');
    assert.equal(h.device('thermostat_18').status.season, 'SUM');
});

test('with the .ksa programs the role is already set when the thermostat is announced', () => {
    const h = panelClient({
        ksaCache: {
            thermostatPrograms: [{ id: '1', description: 'Room', domusSensorId: '1', heatingOutputId: '18', coolingOutputId: '34' }],
            thermostatProgramIdByOutputId: { 18: '1', 34: '1' },
            domusSensorIdByThermostatProgramId: { 1: '1' },
        },
    });
    h.multi();
    assert.equal(h.discovered.get('thermostat_18').status.outputRole, 'heating');
    assert.equal(h.discovered.get('thermostat_34').status.outputRole, 'cooling');
});

test('real stack: in summer the heating output (role from PRG_THERMOSTATS) is heating-only, shows Off and refuses Heat and setpoints', { timeout: 30000 }, async (t) => {
    const h = panelClient();
    h.multi(); h.prg(); h.summer();
    const heating = h.device('thermostat_18');
    const cooling = h.device('thermostat_34');

    const stack = await realMatterStackSession(t).start();
    const ws = stubPanel();
    const registry = new MatterAccessoryRegistry({
        api: stack.api, log: silentLog(), getWsClient: () => ws, storagePath: tmpStorage(t, 'klares4-d-role-'),
    });
    registry.startDiscoveryCycle();
    for (const device of [heating, cooling]) {
        await registry.addOrUpdateAccessory(device);
        await waitFor(() => ['registered', 'failed'].includes(registry.getStatus(device.id)), 10000);
        assert.equal(registry.getStatus(device.id), 'registered');
    }
    const thermo = (id) => stack.read(id, 'thermostat') ?? {};
    assert.equal(thermo('thermostat_18').featureMap.cooling, false, 'the cooling-sounding name did not make it heating-cooling');
    assert.equal(thermo('thermostat_18').systemMode, 0, 'heating output out of season: Off');
    assert.equal(thermo('thermostat_34').systemMode, 3);

    await stack.write('thermostat_18', 'thermostat', { systemMode: 4 });
    await stack.write('thermostat_18', 'thermostat', { occupiedHeatingSetpoint: 2100 });
    await waitFor(() => thermo('thermostat_18').systemMode === 0);
    assert.deepEqual(ws.calls, [], 'nothing may switch the program to winter');

    await stack.write('thermostat_34', 'thermostat', { occupiedCoolingSetpoint: 2500 });
    await waitFor(() => ws.calls.length === 1);
    assert.deepEqual(ws.calls, [['temp', 'thermostat_34', 25]]);
});
