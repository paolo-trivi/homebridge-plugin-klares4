const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '5';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '10';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { buildThermostatMatterState } = require('../dist/platform/matter-thermostat-mapper.js');
const { makeHb24MatterApi } = require('./fixtures/hb24-matter-api.js');

const silentLog = () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storage = () => fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-thermo-handlers-'));

// SetpointRaiseLowerMode: Heat=0, Cool=1, Both=2 (Matter §4.3.8.1).
const HEAT = 0;
const COOL = 1;

function thermostat(name, mode, target, current = 21) {
    const status = { currentTemperature: current, targetTemperature: target, mode };
    return {
        id: 'thermostat_3', type: 'thermostat', name, description: '',
        currentTemperature: current, targetTemperature: target, mode, status,
    };
}

function wsClient({ failTimes = 0 } = {}) {
    const calls = [];
    let failures = failTimes;
    const maybeFail = () => {
        if (failures > 0) {
            failures -= 1;
            throw new Error('WRITE_CFG_RES RESULT=FAIL');
        }
    };
    return {
        calls,
        async setThermostatTemperature(id, t) { calls.push({ op: 'temp', id, t }); maybeFail(); },
        async setThermostatMode(id, mode) { calls.push({ op: 'mode', id, mode }); maybeFail(); },
    };
}

async function setup(device, ws = wsClient()) {
    const hb = makeHb24MatterApi();
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => ws, storagePath: storage() });
    await registry.addOrUpdateAccessory(device);
    await delay(60);
    assert.equal(registry.getStatus('thermostat_3'), 'registered');
    const invoke = (command, args) => hb.invoke('thermostat_3', 'thermostat', command, args);
    return { hb, registry, ws, invoke };
}

test('handlers read the latest snapshot: a value the panel changed is no longer "already current"', async () => {
    const { registry, ws, invoke } = await setup(thermostat('Riscaldamento Sala', 'heat', 20));
    // The panel moves the setpoint to 22 °C; the plugin pushes it to Matter.
    await registry.updateAccessoryState(thermostat('Riscaldamento Sala', 'heat', 22));
    await delay(30);
    // The user sets 20 °C again from a controller.
    await invoke('occupiedHeatingSetpointChange', { occupiedHeatingSetpoint: 2000 });
    assert.deepEqual(ws.calls, [{ op: 'temp', id: 'thermostat_3', t: 20 }]);
});

test('handlers read the latest mode: switching back to the original mode is forwarded', async () => {
    const { registry, ws, invoke } = await setup(thermostat('Riscaldamento Sala', 'heat', 20));
    await registry.updateAccessoryState(thermostat('Riscaldamento Sala', 'off', 20));
    await delay(30);
    await invoke('systemModeChange', { systemMode: 4 });
    assert.deepEqual(ws.calls, [{ op: 'mode', id: 'thermostat_3', mode: 'heat' }]);
});

test('setpointRaiseLower honours args.mode: a Cool adjustment never moves the heating target', async () => {
    const { ws, invoke } = await setup(thermostat('Climatizzazione Sala', 'heat', 22));
    await invoke('setpointRaiseLower', { mode: COOL, amount: 10 });
    assert.deepEqual(ws.calls, []);
    await invoke('setpointRaiseLower', { mode: HEAT, amount: 10 });
    assert.deepEqual(ws.calls, [{ op: 'temp', id: 'thermostat_3', t: 23 }]);
});

test('setpointRaiseLower in cool mode adjusts the cooling target from the latest value', async () => {
    const { registry, ws, invoke } = await setup(thermostat('Climatizzazione Sala', 'cool', 26));
    await registry.updateAccessoryState(thermostat('Climatizzazione Sala', 'cool', 25));
    await delay(30);
    await invoke('setpointRaiseLower', { mode: HEAT, amount: 10 });
    assert.deepEqual(ws.calls, []);
    await invoke('setpointRaiseLower', { mode: COOL, amount: -10 });
    assert.deepEqual(ws.calls, [{ op: 'temp', id: 'thermostat_3', t: 24 }]);
});

test('F15: a rejected setpoint re-publishes the known state to Matter', async () => {
    const { hb, invoke } = await setup(thermostat('Riscaldamento Sala', 'heat', 20), wsClient({ failTimes: 1 }));
    const before = hb.updates.length;
    await assert.doesNotReject(() => invoke('occupiedHeatingSetpointChange', { occupiedHeatingSetpoint: 2300 }));
    await delay(30);
    const restore = hb.updates.slice(before).find((u) => u.cluster === 'thermostat');
    assert.ok(restore, 'expected a thermostat state push after the failure');
    assert.equal(restore.attributes.occupiedHeatingSetpoint, 2000);
});

test('F15: a rejected mode change re-publishes the known mode', async () => {
    const { hb, invoke } = await setup(thermostat('Riscaldamento Sala', 'heat', 20), wsClient({ failTimes: 1 }));
    const before = hb.updates.length;
    await invoke('systemModeChange', { systemMode: 0 });
    await delay(30);
    const restore = hb.updates.slice(before).find((u) => u.cluster === 'thermostat');
    assert.equal(restore?.attributes.systemMode, 4);
});

test('F33: after a failure the same value retried within the echo TTL is forwarded again', async () => {
    const { ws, invoke } = await setup(thermostat('Riscaldamento Sala', 'heat', 20), wsClient({ failTimes: 1 }));
    await invoke('occupiedHeatingSetpointChange', { occupiedHeatingSetpoint: 2300 });
    await delay(30);
    await invoke('occupiedHeatingSetpointChange', { occupiedHeatingSetpoint: 2300 });
    assert.equal(ws.calls.filter((c) => c.op === 'temp' && c.t === 23).length, 2);
});

test('F21: in cool mode the Ksenia target is the cooling setpoint', () => {
    const { base } = buildThermostatMatterState(thermostat('Climatizzazione Sala', 'cool', 26));
    assert.equal(base.occupiedCoolingSetpoint, 2600);
    assert.ok(base.occupiedCoolingSetpoint - base.occupiedHeatingSetpoint >= 200, 'deadband respected');
    const heat = buildThermostatMatterState(thermostat('Climatizzazione Sala', 'heat', 21)).base;
    assert.equal(heat.occupiedHeatingSetpoint, 2100);
    const heatingOnly = buildThermostatMatterState(thermostat('Riscaldamento Sala', 'cool', 21)).base;
    assert.equal(heatingOnly.occupiedHeatingSetpoint, 2100, 'heating-only zones keep the heating mapping');
});

test('F21: deadband adjustments of the non-active setpoint are not forwarded to the panel', async () => {
    const heat = await setup(thermostat('Climatizzazione Sala', 'heat', 23));
    // matter.js pushed cooling up to keep the deadband after the user set heating.
    await heat.invoke('occupiedCoolingSetpointChange', { occupiedCoolingSetpoint: 2500 });
    assert.deepEqual(heat.ws.calls, []);

    const cool = await setup(thermostat('Climatizzazione Sala', 'cool', 26));
    await cool.invoke('occupiedHeatingSetpointChange', { occupiedHeatingSetpoint: 2300 });
    assert.deepEqual(cool.ws.calls, []);
    await cool.invoke('occupiedCoolingSetpointChange', { occupiedCoolingSetpoint: 2700 });
    assert.deepEqual(cool.ws.calls, [{ op: 'temp', id: 'thermostat_3', t: 27 }]);
});
