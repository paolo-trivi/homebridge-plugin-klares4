'use strict';

// Findings of the rc.1 review on Matter thermostats: H1 (updates built for the
// registered endpoint, never for a role it does not have), M-02 (a sensor
// fallback that comes back keeps its identity), M1 (an ACK-confirmed value
// ends at the first realtime after it), L2 (an initial push applied after a
// controller write does not undo it), M3 (state pushes wait for a running
// command), and the warning for a refused state update.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '3000';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '10';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '50';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '10';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { mapThermostatAsTemperatureSensor } = require('../dist/platform/matter-device-mapper.js');
const { MatterThermostatEchoTracker } = require('../dist/platform/matter-thermostat-echo-tracker.js');
const { markStatusObserved } = require('../dist/device-observation.js');
const { updateThermostatStatus } = require('../dist/thermostat-state.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');
const { makeHbMatterApi } = require('./fixtures/hb-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const PLUGIN = 'homebridge-plugin-klares4';
const PLATFORM = 'Lares4Complete';
const FALLBACK_FILE = 'klares4-matter-fallback.json';
const SLOW = { timeout: 120000 };

function recordingLog() {
    const lines = [];
    const at = (level) => (msg) => lines.push(`[${level}] ${msg}`);
    return { lines, log: { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug'), success: at('info') } };
}

function thermostat(n, { mode = 'heat', target = 21, current = 20.5, role } = {}) {
    const status = { currentTemperature: current, targetTemperature: target, mode };
    if (role) status.outputRole = role;
    const device = {
        id: `thermostat_${n}`, type: 'thermostat', name: `Termostato prova ${n}`, description: '',
        currentTemperature: current, targetTemperature: target, mode, status,
    };
    markStatusObserved(device);
    return device;
}

async function boot(t, { ws, storagePath = tmpStorage(t, 'klares4-thermo-rc1-'), session = realMatterStackSession(t) } = {}) {
    const stack = await session.start();
    const { lines, log } = recordingLog();
    const registry = new MatterAccessoryRegistry({ api: stack.api, log, getWsClient: () => ws, storagePath });
    for (const accessory of stack.cached()) registry.configureCachedAccessory(accessory);
    registry.startDiscoveryCycle();
    const add = async (device) => {
        await registry.addOrUpdateAccessory(device);
        await waitFor(() => ['registered', 'failed'].includes(registry.getStatus(device.id)), 30000);
        return registry.getStatus(device.id);
    };
    return { stack, registry, lines, add, storagePath, session };
}

const thermo = (stack, id) => stack.read(id, 'thermostat') ?? {};

test('H1: a role that changes while the endpoint cannot be replaced: updates keep the registered shape and keep flowing', SLOW, async (t) => {
    const b = await boot(t, { ws: { async setThermostatTemperature() {}, async setThermostatMode() {} } });
    const device = thermostat(1, { role: 'heating' });
    assert.equal(await b.add(device), 'registered');
    // Homebridge does not let the endpoint go: the replacement cannot happen.
    t.mock.method(b.stack.api.matter, 'unregisterPlatformAccessories', async () => { throw new Error('refused'); });

    device.status.outputRole = 'heating-cooling';
    for (const temp of [22, 23.5]) {
        updateThermostatStatus(device, { currentTemperature: temp });
        await b.registry.updateAccessoryState(device);
        await waitFor(() => thermo(b.stack, 'thermostat_1').localTemperature === Math.round(temp * 100), 30000);
    }
    await waitFor(() => b.lines.some((l) => /keeps its previous Thermostat endpoint/.test(l)), 30000);
    assert.equal(b.stack.hbLines.some((l) => /Rolling back/.test(l)), false, 'no update carried an attribute the endpoint lacks');
    assert.equal(thermo(b.stack, 'thermostat_1').controlSequenceOfOperation, 2);
});

test('H1 (iv): a state update Homebridge refuses is a warning naming the device', async (t) => {
    const hb = makeHbMatterApi();
    const { lines, log } = recordingLog();
    const registry = new MatterAccessoryRegistry({ api: hb.api, log, getWsClient: () => undefined, storagePath: tmpStorage(t, 'klares4-thermo-rc1-') });
    const device = thermostat(2, { role: 'heating' });
    await registry.addOrUpdateAccessory(device);
    await waitFor(() => registry.getStatus('thermostat_2') === 'registered');
    t.mock.method(hb.api.matter, 'updateAccessoryState', async () => { throw new Error('Conformance "COOL": Matter does not allow you to set this attribute'); });
    updateThermostatStatus(device, { currentTemperature: 19 });
    await registry.updateAccessoryState(device);
    await waitFor(() => lines.some((l) => l.startsWith('[warn]') && l.includes('Termostato prova 2') && /refused/.test(l)));
});

test('M-02: a 2.2.0 sensor fallback whose recovery fails comes back with its own identity', SLOW, async (t) => {
    const session = realMatterStackSession(t);
    const storagePath = tmpStorage(t, 'klares4-thermo-rc1-');
    const device = thermostat(3, { role: 'heating' });

    const boot1 = await session.start();
    await boot1.api.matter.registerPlatformAccessories(PLUGIN, PLATFORM, [
        mapThermostatAsTemperatureSensor(device, { api: boot1.api, log: recordingLog().log, getWsClient: () => undefined }),
    ]);
    const sensorId = boot1.read('thermostat_3', 'bridgedDeviceBasicInformation').uniqueId;
    await boot1.stop();
    fs.writeFileSync(path.join(storagePath, FALLBACK_FILE), JSON.stringify({ thermostatAsTemperatureSensor: ['thermostat_3'] }));

    // Boot 2 on a runtime that does not create the Thermostat (any payload).
    const stack = await session.start();
    const register = stack.api.matter.registerPlatformAccessories.bind(stack.api.matter);
    stack.api.matter.registerPlatformAccessories = async (plugin, platform, list) => register(plugin, platform, list.filter((a) => !a.clusters?.thermostat));
    const { lines, log } = recordingLog();
    const registry = new MatterAccessoryRegistry({ api: stack.api, log, getWsClient: () => undefined, storagePath });
    for (const accessory of stack.cached()) registry.configureCachedAccessory(accessory);
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(device);
    await waitFor(() => stack.deviceTypeName('thermostat_3') === 'TemperatureSensor' && registry.getStatus('thermostat_3') === 'registered', 60000);
    assert.ok(lines.some((l) => /trying the native Thermostat once/.test(l)));
    await waitFor(() => stack.read('thermostat_3', 'bridgedDeviceBasicInformation')?.uniqueId === sensorId, 30000);
});

test('M1: an ACK-confirmed value ends at the first realtime after it, whatever it reports', () => {
    let now = 1000;
    const tracker = new MatterThermostatEchoTracker(10_000, () => now, 15_000);
    tracker.recordConfirmed('t', 'target', 25);
    assert.equal(tracker.effectiveTarget('t', 24, 900), 25, 'a realtime older than the ACK does not end it');
    now = 2000;
    assert.equal(tracker.effectiveTarget('t', 19, 1500), 19, 'another source set 19 after the ACK');
    assert.equal(tracker.effectiveTarget('t', 19), 19, 'and the entry is gone');
    tracker.recordConfirmed('t', 'mode', 'heat');
    assert.equal(tracker.effectiveMode('t', 'off', 2500), 'off', 'Off from the keypad after the ACK');
});

test('M1 on the real stack: +1 after a change from another source starts from that change', SLOW, async (t) => {
    const calls = [];
    const ws = { async setThermostatTemperature(id, v) { calls.push(v); }, async setThermostatMode() {} };
    const b = await boot(t, { ws });
    const device = thermostat(4, { role: 'heating', target: 24 });
    assert.equal(await b.add(device), 'registered');
    await b.stack.invoke('thermostat_4', 'thermostat', 'setpointRaiseLower', { mode: 0, amount: 10 });
    assert.deepEqual(calls, [25]);
    // The keypad sets 19; the realtime (observedAt) reports it.
    updateThermostatStatus(device, { targetTemperature: 19 });
    device.status.observedAt = Date.now() + 1;
    await b.registry.updateAccessoryState(device);
    await waitFor(() => thermo(b.stack, 'thermostat_4').occupiedHeatingSetpoint === 1900, 30000);
    await b.stack.invoke('thermostat_4', 'thermostat', 'setpointRaiseLower', { mode: 0, amount: 10 });
    assert.deepEqual(calls, [25, 20]);
});

test('L2: a push applied after a controller write is an echo; a value equal to the live state is not recorded', () => {
    const tracker = new MatterThermostatEchoTracker();
    // The initial push (2100) is recorded, the controller writes 2250 before it is applied.
    tracker.recordPushed('t', { occupiedHeatingSetpoint: 2100 }, { occupiedHeatingSetpoint: 2000 });
    assert.equal(tracker.isEcho('t', 'occupiedHeatingSetpoint', 2250), false, 'the controller write is a command');
    assert.equal(tracker.isEcho('t', 'occupiedHeatingSetpoint', 2100), true, 'the late push is ours');
    // A push equal to the live value fires nothing: it must not swallow a later write of that value.
    tracker.recordPushed('t', { occupiedHeatingSetpoint: 2300 }, { occupiedHeatingSetpoint: 2300 });
    assert.equal(tracker.isEcho('t', 'occupiedHeatingSetpoint', 2300), false);
    // Pushes are applied in order: a match uses up the older values too.
    tracker.recordPushed('t', { systemMode: 4 }, { systemMode: 0 });
    tracker.recordPushed('t', { systemMode: 0 }, { systemMode: 0 });
    tracker.recordPushed('t', { systemMode: 3 }, { systemMode: 0 });
    assert.equal(tracker.isEcho('t', 'systemMode', 3), true);
    assert.equal(tracker.isEcho('t', 'systemMode', 4), false);
});

test('M3: state pushes wait while a Matter command runs on the endpoint, and resume after it', async (t) => {
    const hb = makeHbMatterApi();
    let release;
    const ws = { setThermostatTemperature: () => new Promise((resolve) => { release = resolve; }), async setThermostatMode() {} };
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: recordingLog().log, getWsClient: () => ws, storagePath: tmpStorage(t, 'klares4-thermo-rc1-') });
    const device = thermostat(5, { role: 'heating' });
    await registry.addOrUpdateAccessory(device);
    await waitFor(() => registry.getStatus('thermostat_5') === 'registered');
    await hb.settle();
    const command = hb.invoke('thermostat_5', 'thermostat', 'occupiedHeatingSetpointChange', { occupiedHeatingSetpoint: 2400 });
    await waitFor(() => typeof release === 'function');
    const before = hb.updates.length;
    updateThermostatStatus(device, { currentTemperature: 18 });
    await registry.updateAccessoryState(device);
    // Unheld, the flush (a 0 ms timer) and its application (next ticks) would land here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await hb.settle();
    assert.equal(hb.updates.length, before, 'held while the command runs');
    release();
    await command;
    await waitFor(() => hb.updates.slice(before).some((u) => u.uuid === 'thermostat_5' && u.attributes.localTemperature === 1800));
});
