const test = require('node:test');
const assert = require('node:assert/strict');

const { CommandService } = require('../dist/websocket-client/command-service.js');
const { buildThermostatSetpointCommandPayload } = require('../dist/websocket-client/thermostat-command-payload.js');
const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');
const { ThermostatStatusUpdater } = require('../dist/websocket-client/thermostat-status-updater.js');

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

// Synthetic cfg shaped like a real CFG_THERMOSTATS entry.
function cfg(season) {
    return { ID: '1', ACT_MODE: 'OFF', ACT_SEA: season, MAN_HRS: '0', TOF: '5.0', WIN: { TM: '21.5' }, SUM: { TM: '26.0' } };
}

function makeService({ season = 'WIN', snapshot } = {}) {
    const writes = [];
    const state = {
        idLogin: '3',
        ws: { readyState: 1 },
        thermostatProgramById: new Map([['1', { ID: '1', PERIPH: { PID: '1' }, HEATING_OUT: '18' }]]),
        thermostatProgramIdByOutputId: new Map([['18', '1']]),
        domusSensorIdByThermostatProgramId: new Map([['1', '1']]),
        thermostatCommandIdByOutputId: new Map(),
        thermostatCfgById: new Map([['1', cfg(season)]]),
        thermostatRealtimeSeasonByOutputId: new Map(snapshot ? [['18', snapshot]] : []),
        domusThermostatConfig: { enabled: true, manualPairs: [], manualCommandPairs: [], sensorFreshnessMs: 300000 },
        thermostatToDomus: new Map([['18', '1']]),
        missingThermostatProgramWarningOutputIds: new Set(),
    };
    const service = new CommandService({
        state, sender: 's', pin: '0000', log, logLevel: 1, options: {},
        commandDispatcher: { enqueueDeviceCommand: (_id, task) => task() },
        wsTransport: { send: async () => undefined },
        emitRawMessage: () => undefined,
    });
    let reject = false;
    service.sendKseniaCommand = async (cmd, type, payload) => {
        writes.push(payload.CFG_THERMOSTATS[0]);
        if (reject) throw new Error('WRITE_CFG_RES RESULT=FAIL');
    };
    return { service, state, writes, rejectNext: (v) => { reject = v; } };
}

test('F06: summer cfg without a session hint writes the summer setpoint', () => {
    const payload = buildThermostatSetpointCommandPayload({
        systemThermostatId: '1', temperature: 23, existingCfg: cfg('SUM'),
    });
    assert.equal(payload.ACT_SEA, 'SUM');
    assert.equal(payload.SUM.TM, '23.0');
    assert.equal(payload.WIN.TM, '21.5');
});

test('F06: after a restart a setpoint on a summer thermostat changes SUM.TM', async () => {
    const h = makeService({ season: 'SUM' });
    await h.service.setThermostatTemperature('thermostat_18', 23);
    assert.equal(h.writes[0].ACT_SEA, 'SUM');
    assert.equal(h.writes[0].SUM.TM, '23.0');
});

test('F06: a rejected "cool" command does not move later setpoints to the summer season', async () => {
    const h = makeService({ season: 'WIN' });
    h.rejectNext(true);
    await assert.rejects(() => h.service.setThermostatMode('thermostat_18', 'cool'));
    h.rejectNext(false);
    await h.service.setThermostatTemperature('thermostat_18', 21);
    const last = h.writes.at(-1);
    assert.equal(last.ACT_SEA, 'WIN');
    assert.equal(last.WIN.TM, '21.0');
    assert.equal(last.SUM.TM, '26.0');
});

test('F06: a season changed on the panel (realtime) wins over an older acknowledged write', async () => {
    const h = makeService({ season: 'WIN' });
    await h.service.setThermostatMode('thermostat_18', 'cool');
    // Later the keypad switches back to winter; the panel reports it in realtime.
    h.state.thermostatRealtimeSeasonByOutputId.set('18', { season: 'WIN', updatedAt: Date.now() + 1000 });
    await h.service.setThermostatTemperature('thermostat_18', 20);
    const last = h.writes.at(-1);
    assert.equal(last.ACT_SEA, 'WIN');
    assert.equal(last.WIN.TM, '20.0');
});

test('F06: an acknowledged "cool" is used for the next setpoint before realtime catches up', async () => {
    const h = makeService({ season: 'WIN', snapshot: { season: 'WIN', updatedAt: Date.now() - 60000 } });
    await h.service.setThermostatMode('thermostat_18', 'cool');
    await h.service.setThermostatTemperature('thermostat_18', 25);
    const last = h.writes.at(-1);
    assert.equal(last.ACT_SEA, 'SUM');
    assert.equal(last.SUM.TM, '25.0');
});

// Swapped (cfg, sensor) pairs, as on real installs: Matrimoniale output 21 is
// cfg 3 with DOMUS sensor 4, Bagno output 20 is cfg 4 with DOMUS sensor 3.
// STATUS_TEMPERATURES is keyed by the DOMUS sensor id, never by the cfg id.
function makeSwappedPairs() {
    const state = createInitialWebSocketClientState();
    state.idLogin = '3';
    state.ws = { readyState: 1 };
    for (const id of ['20', '21']) {
        state.devices.set('thermostat_' + id, {
            id: 'thermostat_' + id, type: 'thermostat', name: id, description: id,
            status: { currentTemperature: 20, targetTemperature: 21, mode: 'heat' },
        });
    }
    state.thermostatProgramById.set('3', { ID: '3', PERIPH: { PID: '4' }, HEATING_OUT: '21' });
    state.thermostatProgramById.set('4', { ID: '4', PERIPH: { PID: '3' }, HEATING_OUT: '20' });
    state.thermostatProgramIdByOutputId.set('21', '3').set('20', '4');
    state.domusSensorIdByThermostatProgramId.set('3', '4').set('4', '3');
    state.thermostatToDomus.set('21', '4').set('20', '3');
    // Cached cfgs both say winter; the panel has since moved cfg 3 to summer.
    state.thermostatCfgById.set('3', { ...cfg('WIN'), ID: '3', ACT_MODE: 'MAN' });
    state.thermostatCfgById.set('4', { ...cfg('WIN'), ID: '4', ACT_MODE: 'MAN' });
    const updater = new ThermostatStatusUpdater({ state, emitDeviceStatusUpdate: () => undefined });
    updater.updateTemperatureStatuses([
        { ID: '4', TEMP: '24.0', THERM: { ACT_MODEL: 'MAN', ACT_SEA: 'SUM', TEMP_THR: { T: 'M', VAL: '26.0' } } },
        { ID: '3', TEMP: '20.0', THERM: { ACT_MODEL: 'MAN', ACT_SEA: 'WIN', TEMP_THR: { T: 'M', VAL: '21.5' } } },
    ]);
    const writes = [];
    const service = new CommandService({
        state, sender: 's', pin: '0000', log, logLevel: 1, options: {},
        commandDispatcher: { enqueueDeviceCommand: (_id, task) => task() },
        wsTransport: { send: async () => undefined },
        emitRawMessage: () => undefined,
    });
    service.sendKseniaCommand = async (_cmd, _type, payload) => { writes.push(payload.CFG_THERMOSTATS[0]); };
    return { service, writes };
}

test('F06: the realtime season is looked up for the thermostat written, not for the sensor sharing its cfg id', async () => {
    const h = makeSwappedPairs();
    await h.service.setThermostatTemperature('thermostat_21', 24);
    assert.equal(h.writes[0].ID, '3');
    assert.equal(h.writes[0].ACT_SEA, 'SUM');
    assert.equal(h.writes[0].SUM.TM, '24.0');
    assert.equal(h.writes[0].WIN.TM, '21.5');

    await h.service.setThermostatTemperature('thermostat_20', 22);
    assert.equal(h.writes[1].ID, '4');
    assert.equal(h.writes[1].ACT_SEA, 'WIN');
    assert.equal(h.writes[1].WIN.TM, '22.0');
});
