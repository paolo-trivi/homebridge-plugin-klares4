'use strict';

// Matter thermostats on the real Homebridge/matter.js stack installed in
// node_modules (test/fixtures/real-matter-stack.js): registration, feature map,
// controller writes and commands, running state, recovery of old fallbacks and
// restart with cache. The in-memory fixture cannot see conformance; this can.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '2000';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '10';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '50';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '10';

const { deviceToMatterAccessory, mapThermostatAsTemperatureSensor } = require('../dist/platform/matter-device-mapper.js');
const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { markStatusObserved, markStatusPlaceholder } = require('../dist/device-observation.js');
const { updateThermostatStatus } = require('../dist/thermostat-state.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const PLUGIN = 'homebridge-plugin-klares4';
const PLATFORM = 'Lares4Complete';
const FALLBACK_FILE = 'klares4-matter-fallback.json';

function recordingLog() {
    const lines = [];
    const at = (level) => (msg) => lines.push(`[${level}] ${msg}`);
    return { lines, log: { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug'), success: at('info') } };
}

/** A panel that acknowledges at once; its realtime only comes when the test sends it. */
function panel() {
    const calls = [];
    return {
        calls,
        async setThermostatTemperature(id, value) { calls.push(['temp', id, value]); },
        async setThermostatMode(id, mode) { calls.push(['mode', id, mode]); },
    };
}

function thermostat(n, { mode = 'heat', target = 21, current = 20.5, role, season, active } = {}) {
    const status = { currentTemperature: current, targetTemperature: target, mode };
    if (season) status.season = season === 'summer' ? 'SUM' : 'WIN';
    if (active !== undefined) status.hvacOutputActive = active;
    const device = {
        id: `thermostat_${n}`, type: 'thermostat', name: `Termostato prova ${n}`, description: '',
        currentTemperature: current, targetTemperature: target, mode, status,
    };
    if (role) status.outputRole = role;
    markStatusObserved(device);
    return device;
}

async function bootWithRegistry(t, { ws = panel(), storagePath = tmpStorage(t, 'klares4-thermo-rs-'), session = realMatterStackSession(t), recoveryRequests } = {}) {
    const stack = await session.start();
    const { lines, log } = recordingLog();
    const registry = new MatterAccessoryRegistry({
        api: stack.api, log, getWsClient: () => (ws.offline ? undefined : ws), storagePath, recoveryRequests,
    });
    for (const accessory of stack.cached()) registry.configureCachedAccessory(accessory);
    registry.startDiscoveryCycle();
    const add = async (device) => {
        await registry.addOrUpdateAccessory(device);
        await waitFor(() => ['registered', 'failed'].includes(registry.getStatus(device.id)), 10000);
        assert.equal(registry.getStatus(device.id), 'registered');
    };
    /** A realtime from the panel, as the WebSocket layer delivers it. */
    const realtime = async (device, patch) => {
        updateThermostatStatus(device, patch);
        await registry.updateAccessoryState(device);
    };
    return { stack, registry, ws, lines, add, realtime, storagePath, session };
}

const thermo = (stack, uuid) => stack.read(uuid, 'thermostat') ?? {};
const warned = (lines, pattern) => lines.some((l) => l.startsWith('[warn]') && pattern.test(l));

test('TH-01: the registry registers a thermostat as a native Thermostat and persists no fallback', { timeout: 30000 }, async (t) => {
    const { stack, add, storagePath, lines } = await bootWithRegistry(t);
    await add(thermostat(1));
    assert.equal(stack.deviceTypeName('thermostat_1'), 'Thermostat');
    assert.equal(thermo(stack, 'thermostat_1').occupiedHeatingSetpoint, 2100);
    assert.equal(fs.existsSync(path.join(storagePath, FALLBACK_FILE)), false);
    assert.equal(lines.some((l) => /falling back|TemperatureSensor/.test(l)), false, lines.join('\n'));
});

test('a temperature never read is unknown (null) on the native Thermostat, not 0 °C; the first reading fills it', { timeout: 30000 }, async (t) => {
    const { stack, registry } = await bootWithRegistry(t);
    const device = thermostat(13, { role: 'heating' });
    markStatusPlaceholder(device);
    await registry.addOrUpdateAccessory(device);
    await waitFor(() => registry.getStatus(device.id) === 'registered', 10000);
    assert.equal(stack.deviceTypeName(device.id), 'Thermostat', 'the strict probe accepts a heating-only Thermostat');
    assert.equal(thermo(stack, device.id).localTemperature, null);

    const read = thermostat(13, { role: 'heating', current: 19.5 });
    await registry.updateAccessoryState(read);
    await waitFor(() => thermo(stack, device.id).localTemperature === 1950);
});

test('TH-01/TH-09/TH-05: the feature map follows the output role, never Occupancy or Presets', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const deps = { api: stack.api, log: recordingLog().log, getWsClient: () => panel() };
    const cases = [
        [thermostat(2, { role: 'heating' }), { heating: true, cooling: false, autoMode: false }, 2],
        [thermostat(3, { role: 'cooling', mode: 'cool', target: 26 }), { heating: false, cooling: true, autoMode: false }, 0],
        [thermostat(4, { role: 'heating-cooling' }), { heating: true, cooling: true, autoMode: true }, 4],
    ];
    for (const [device, features, sequence] of cases) {
        await stack.api.matter.registerPlatformAccessories(PLUGIN, PLATFORM, [deviceToMatterAccessory(device, deps)]);
        const state = thermo(stack, device.id);
        assert.equal(stack.deviceTypeName(device.id), 'Thermostat', device.status.outputRole);
        for (const [feature, on] of Object.entries(features)) assert.equal(state.featureMap[feature], on, `${device.status.outputRole}.${feature}`);
        assert.equal(state.featureMap.occupancy, false);
        assert.equal(state.featureMap.presets, false);
        assert.equal(state.controlSequenceOfOperation, sequence);
    }
});

test('TH-05/invariant 3: the program data decides the role, a cooling-sounding name does not', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const device = { ...thermostat(5, { role: 'heating' }), name: 'Raffrescamento prova' };
    await stack.api.matter.registerPlatformAccessories(PLUGIN, PLATFORM, [deviceToMatterAccessory(device, { api: stack.api, log: recordingLog().log, getWsClient: () => panel() })]);
    assert.equal(thermo(stack, 'thermostat_5').featureMap.cooling, false);
});

test('TH-15/TH-09: a heating output refuses Auto, Cool and unoccupied setpoints to the controller; nothing reaches the panel', { timeout: 30000 }, async (t) => {
    const { stack, add, ws } = await bootWithRegistry(t);
    await add(thermostat(6, { role: 'heating' }));
    await assert.rejects(stack.write('thermostat_6', 'thermostat', { systemMode: 1 }), /Auto/);
    await assert.rejects(stack.write('thermostat_6', 'thermostat', { systemMode: 3 }), /Cool/);
    await assert.rejects(stack.write('thermostat_6', 'thermostat', { unoccupiedHeatingSetpoint: 1800 }));
    assert.equal(thermo(stack, 'thermostat_6').systemMode, 4);
    assert.deepEqual(ws.calls, []);
});

test('TH-10: the running state is published at registration and follows the output', { timeout: 30000 }, async (t) => {
    const { stack, add, realtime } = await bootWithRegistry(t);
    const device = thermostat(7, { role: 'heating', active: true });
    await add(device);
    assert.equal(thermo(stack, 'thermostat_7').thermostatRunningState.heat, true);
    await realtime(device, { hvacOutputActive: false });
    await waitFor(() => thermo(stack, 'thermostat_7').thermostatRunningState.heat === false);
    assert.equal(thermo(stack, 'thermostat_7').thermostatRunningState.cool, false);
});

test('TH-05: in summer the heating output shows Off and refuses a setpoint and Heat; the cooling output works', { timeout: 30000 }, async (t) => {
    const { stack, add, ws, lines } = await bootWithRegistry(t);
    await add(thermostat(8, { role: 'heating', mode: 'cool', target: 26 }));
    await add(thermostat(9, { role: 'cooling', mode: 'cool', target: 26 }));
    assert.equal(thermo(stack, 'thermostat_8').systemMode, 0);
    assert.equal(thermo(stack, 'thermostat_9').systemMode, 3);
    assert.equal(thermo(stack, 'thermostat_9').occupiedCoolingSetpoint, 2600);

    await stack.write('thermostat_8', 'thermostat', { occupiedHeatingSetpoint: 2100 });
    await waitFor(() => warned(lines, /occupiedHeatingSetpoint 21\.00°C not forwarded/));
    await waitFor(() => thermo(stack, 'thermostat_8').occupiedHeatingSetpoint === 2600);

    await stack.write('thermostat_8', 'thermostat', { systemMode: 4 });
    await waitFor(() => warned(lines, /systemMode heat not forwarded/));
    await waitFor(() => thermo(stack, 'thermostat_8').systemMode === 0);
    assert.deepEqual(ws.calls, [], 'nothing may switch the program to winter');

    await stack.write('thermostat_9', 'thermostat', { occupiedCoolingSetpoint: 2500 });
    await waitFor(() => ws.calls.length === 1);
    assert.deepEqual(ws.calls, [['temp', 'thermostat_9', 25]]);
});

test('TH-08: a value the panel acknowledged is the base until the realtime catches up', { timeout: 30000 }, async (t) => {
    const { stack, add, ws } = await bootWithRegistry(t);
    await add(thermostat(10, { role: 'heating', target: 21 }));

    // F33: two +1 °C steps before the realtime add up.
    await stack.invoke('thermostat_10', 'thermostat', 'setpointRaiseLower', { mode: 0, amount: 10 });
    await stack.invoke('thermostat_10', 'thermostat', 'setpointRaiseLower', { mode: 0, amount: 10 });
    assert.deepEqual(ws.calls, [['temp', 'thermostat_10', 22], ['temp', 'thermostat_10', 23]]);

    // Set 26, then back to 23 before the realtime: the second one is not "already current".
    ws.calls.length = 0;
    await stack.write('thermostat_10', 'thermostat', { occupiedHeatingSetpoint: 2600 });
    await waitFor(() => ws.calls.length === 1);
    await stack.write('thermostat_10', 'thermostat', { occupiedHeatingSetpoint: 2300 });
    await waitFor(() => ws.calls.length === 2);
    assert.deepEqual(ws.calls, [['temp', 'thermostat_10', 26], ['temp', 'thermostat_10', 23]]);

    // Off then Heat before the realtime: both reach the panel.
    ws.calls.length = 0;
    await stack.write('thermostat_10', 'thermostat', { systemMode: 0 });
    await waitFor(() => ws.calls.length === 1);
    await stack.write('thermostat_10', 'thermostat', { systemMode: 4 });
    await waitFor(() => ws.calls.length === 2);
    assert.deepEqual(ws.calls, [['mode', 'thermostat_10', 'off'], ['mode', 'thermostat_10', 'heat']]);
});

test('TH-17/MAT-15: without a WebSocket client a Matter write fails visibly and the value goes back', { timeout: 30000 }, async (t) => {
    const ws = panel();
    const { stack, add, lines } = await bootWithRegistry(t, { ws });
    await add(thermostat(11, { role: 'heating', target: 21 }));
    ws.offline = true;
    await stack.write('thermostat_11', 'thermostat', { occupiedHeatingSetpoint: 2500 });
    await waitFor(() => warned(lines, /no connection to the panel/));
    await waitFor(() => thermo(stack, 'thermostat_11').occupiedHeatingSetpoint === 2100);
    assert.deepEqual(ws.calls, []);
});

test('TH-01: a fallback saved by an earlier version goes back to a native Thermostat once, by itself, and survives a restart', { timeout: 60000 }, async (t) => {
    const session = realMatterStackSession(t);
    const storagePath = tmpStorage(t, 'klares4-thermo-rs-');
    const device = thermostat(12, { role: 'heating' });

    // Boot 1 (as 2.2.0 left it): the thermostat is a TemperatureSensor and the v1 store says so.
    const boot1 = await session.start();
    await boot1.api.matter.registerPlatformAccessories(PLUGIN, PLATFORM, [
        mapThermostatAsTemperatureSensor(device, { api: boot1.api, log: recordingLog().log, getWsClient: () => undefined }),
    ]);
    assert.equal(boot1.deviceTypeName('thermostat_12'), 'TemperatureSensor');
    await boot1.stop();
    fs.writeFileSync(path.join(storagePath, FALLBACK_FILE), JSON.stringify({ thermostatAsTemperatureSensor: ['thermostat_12'] }));

    // Boot 2, no matterRecoveryRequests: one automatic attempt, and it works.
    const boot2 = await bootWithRegistry(t, { session, storagePath });
    await boot2.add(device);
    await waitFor(() => boot2.stack.deviceTypeName('thermostat_12') === 'Thermostat', 10000);
    assert.ok(warned(boot2.lines, /saved as a TemperatureSensor fallback by an earlier version/));
    const record = JSON.parse(fs.readFileSync(path.join(storagePath, FALLBACK_FILE), 'utf8')).thermostats[0];
    assert.equal(record.mode, 'native');
    assert.equal(record.nativeShapeRevision, 2);
    await boot2.stack.stop();

    // Boot 3: a normal restart attaches to the cached Thermostat, nothing is unregistered.
    const boot3 = await bootWithRegistry(t, { session, storagePath });
    const unregisterSpy = t.mock.method(boot3.stack.api.matter, 'unregisterPlatformAccessories');
    await boot3.add(device);
    assert.equal(unregisterSpy.mock.callCount(), 0);
    assert.equal(boot3.stack.deviceTypeName('thermostat_12'), 'Thermostat');
    assert.ok(boot3.stack.hbLines.some((l) => l.includes('Attached plugin registration to restored accessory')));
    assert.equal(thermo(boot3.stack, 'thermostat_12').featureMap.heating, true);
});
