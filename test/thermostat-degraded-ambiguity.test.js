const test = require('node:test');
const assert = require('node:assert/strict');

const { CommandService } = require('../dist/websocket-client/command-service.js');
const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');

// Degraded path: the panel answers PRG_THERMOSTATS with CMD_NOT_AVAILABLE, so
// the cfg id is guessed from the DOMUS sensor id (or the output id).
function makeService({ thermostats, cfgIds, manualCommandPairs = [] }) {
    const state = createInitialWebSocketClientState({ manualCommandPairs });
    state.idLogin = '3';
    state.ws = { readyState: 1 };
    for (const [outputId, sensorId] of Object.entries(thermostats)) {
        state.devices.set('thermostat_' + outputId, {
            id: 'thermostat_' + outputId, type: 'thermostat', name: outputId, description: outputId,
            status: { currentTemperature: 20, targetTemperature: 21, mode: 'heat' },
        });
        if (sensorId) state.thermostatToDomus.set(outputId, sensorId);
    }
    for (const id of cfgIds) {
        state.thermostatCfgById.set(id, { ID: id, ACT_MODE: 'MAN', ACT_SEA: 'WIN', WIN: { TM: '21.0' }, SUM: { TM: '26.0' } });
    }
    const errors = [];
    const log = { info() {}, warn() {}, debug() {}, error: (...args) => errors.push(args.join(' ')) };
    const writes = [];
    const service = new CommandService({
        state, sender: 's', pin: '0000', log, logLevel: 1, options: {},
        commandDispatcher: { enqueueDeviceCommand: (_id, task) => task() },
        wsTransport: { send: async () => undefined },
        emitRawMessage: () => undefined,
    });
    service.sendKseniaCommand = async (cmd, _type, payload) => {
        if (cmd === 'WRITE_CFG') writes.push(payload.CFG_THERMOSTATS[0]);
    };
    return { service, writes, errors };
}

test('real install shape: two outputs on the same DOMUS sensor both write cfg 1', async () => {
    const h = makeService({ thermostats: { 18: '1', 34: '1' }, cfgIds: ['1', '2', '3'] });
    await h.service.setThermostatTemperature('thermostat_18', 22);
    await h.service.setThermostatTemperature('thermostat_34', 23);
    await h.service.setThermostatMode('thermostat_34', 'off');
    assert.deepEqual(h.writes.map((w) => w.ID), ['1', '1', '1']);
    assert.deepEqual(h.errors, []);
});

test('a guessed cfg id that is also another thermostat\'s output id is refused', async () => {
    // Output 7 measures sensor 3, but output 3 (sensor 5) is also a candidate for cfg 3.
    const h = makeService({ thermostats: { 7: '3', 3: '5' }, cfgIds: ['3', '5'] });
    await assert.rejects(() => h.service.setThermostatTemperature('thermostat_7', 22), /manualCommandPairs/);
    await assert.rejects(() => h.service.setThermostatMode('thermostat_7', 'heat'), /manualCommandPairs/);
    assert.deepEqual(h.writes, []);
    assert.ok(h.errors.some((line) => line.includes('thermostat_7') && line.includes('thermostat_3')
        && line.includes('manualCommandPairs')));
});

test('an output-id guess that is another thermostat\'s DOMUS sensor is refused', async () => {
    // Output 4 has no DOMUS mapping; output 9 measures sensor 4, so cfg 4 may be its.
    const h = makeService({ thermostats: { 4: undefined, 9: '4' }, cfgIds: ['4'] });
    await assert.rejects(() => h.service.setThermostatTemperature('thermostat_4', 22), /manualCommandPairs/);
    assert.deepEqual(h.writes, []);
});

test('a manual command pair resolves the ambiguity', async () => {
    const h = makeService({
        thermostats: { 7: '3', 3: '5' },
        cfgIds: ['3', '5'],
        manualCommandPairs: [{ thermostatOutputId: '7', commandThermostatId: '3' }],
    });
    await h.service.setThermostatTemperature('thermostat_7', 22);
    assert.deepEqual(h.writes.map((w) => w.ID), ['3']);
});
