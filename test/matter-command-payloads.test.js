'use strict';

// What a Matter controller command turns into on the panel side (TD-T-04,
// mutations M12 and M60).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '5';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '10';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { makeHbMatterApi } = require('./fixtures/hb-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });

test('goToLiftPercentage converts Matter closed-percent to panel open-percent', { timeout: 10000 }, async (t) => {
    const hb = makeHbMatterApi();
    const calls = [];
    const ws = { moveCover: async (...a) => { calls.push(a); } };
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => ws, storagePath: tmpStorage(t) });
    await registry.addOrUpdateAccessory({ id: 'cover_9', type: 'cover', name: 'Tapparella test', description: '', status: { position: 0, state: 'stopped' } });
    await waitFor(() => registry.getStatus('cover_9') === 'registered');
    await hb.invoke('cover_9', 'windowCovering', 'goToLiftPercentage', { liftPercent100thsValue: 2500 });
    await hb.invoke('cover_9', 'windowCovering', 'goToLiftPercentage', { liftPercent100thsValue: 10000 });
    assert.deepEqual(calls, [['cover_9', 75], ['cover_9', 0]]);
});

test('a Matter setpoint outside the heat limits reaches the panel clamped', { timeout: 10000 }, async (t) => {
    const hb = makeHbMatterApi();
    const calls = [];
    const ws = { async setThermostatTemperature(_id, value) { calls.push(value); }, async setThermostatMode() {} };
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => ws, storagePath: tmpStorage(t) });
    const status = { currentTemperature: 20, targetTemperature: 21, mode: 'heat' };
    await registry.addOrUpdateAccessory({ id: 'thermostat_3', type: 'thermostat', name: 'Termostato prova', description: '', ...status, status });
    await waitFor(() => registry.getStatus('thermostat_3') === 'registered');
    await hb.invoke('thermostat_3', 'thermostat', 'occupiedHeatingSetpointChange', { occupiedHeatingSetpoint: 9900 });
    assert.deepEqual(calls, [30]);
});
