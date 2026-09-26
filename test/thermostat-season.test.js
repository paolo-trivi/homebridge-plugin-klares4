const test = require('node:test');
const assert = require('node:assert/strict');

const { CommandService } = require('../dist/websocket-client/command-service.js');
const { buildThermostatSetpointCommandPayload } = require('../dist/websocket-client/thermostat-command-payload.js');

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
        thermostatRealtimeSnapshotById: new Map(snapshot ? [['1', snapshot]] : []),
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
    h.state.thermostatRealtimeSnapshotById.set('1', { season: 'WIN', mode: 'heat', updatedAt: Date.now() + 1000 });
    await h.service.setThermostatTemperature('thermostat_18', 20);
    const last = h.writes.at(-1);
    assert.equal(last.ACT_SEA, 'WIN');
    assert.equal(last.WIN.TM, '20.0');
});

test('F06: an acknowledged "cool" is used for the next setpoint before realtime catches up', async () => {
    const h = makeService({ season: 'WIN', snapshot: { season: 'WIN', mode: 'heat', updatedAt: Date.now() - 60000 } });
    await h.service.setThermostatMode('thermostat_18', 'cool');
    await h.service.setThermostatTemperature('thermostat_18', 25);
    const last = h.writes.at(-1);
    assert.equal(last.ACT_SEA, 'SUM');
    assert.equal(last.SUM.TM, '25.0');
});
