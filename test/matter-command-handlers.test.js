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
const { makeHb24MatterApi } = require('./fixtures/hb24-matter-api.js');

const silentLog = () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storage = () => fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-commands-'));
const UNSUPPORTED_COMMAND = 0x81;

function wsClient() {
    const calls = [];
    const record = (op) => async (...args) => { calls.push([op, ...args]); };
    return {
        calls,
        switchLight: record('switchLight'),
        dimLight: record('dimLight'),
        moveCover: record('moveCover'),
        triggerScenario: record('triggerScenario'),
        toggleGate: record('toggleGate'),
    };
}

async function setup(device) {
    const hb = makeHb24MatterApi();
    const ws = wsClient();
    const registry = new MatterAccessoryRegistry({
        api: hb.api, log: silentLog(), getWsClient: () => ws, storagePath: storage(), momentaryAutoOffMs: 5,
    });
    await registry.addOrUpdateAccessory(device);
    await delay(60);
    assert.equal(registry.getStatus(device.id), 'registered');
    return { hb, ws, registry };
}

const light = (status) => ({ id: 'light_4', type: 'light', name: 'Luce Cucina', description: '', status });
const cover = (status) => ({ id: 'cover_9', type: 'cover', name: 'Tapparella Studio', description: '', status });

test('OnOff toggle on a light switches it exactly once', async () => {
    const { hb, ws } = await setup(light({ on: false, dimmable: false }));
    await hb.toggle('light_4');
    assert.deepEqual(ws.calls, [['switchLight', 'light_4', true]]);
});

test('OnOff toggle on a scenario or a gate triggers it exactly once', async () => {
    const scenario = await setup({ id: 'scenario_2', type: 'scenario', name: 'Notte', description: '', status: { active: false } });
    await scenario.hb.toggle('scenario_2');
    assert.deepEqual(scenario.ws.calls, [['triggerScenario', 'scenario_2']]);

    const gate = await setup({ id: 'gate_1', type: 'gate', name: 'Cancello', description: '', status: { on: false } });
    await gate.hb.toggle('gate_1');
    assert.deepEqual(gate.ws.calls, [['toggleGate', 'gate_1']]);
});

test('LevelControl step moves from the latest known level', async () => {
    const { hb, ws, registry } = await setup(light({ on: true, dimmable: true, brightness: 20 }));
    await registry.updateAccessoryState(light({ on: true, dimmable: true, brightness: 40 }));
    await delay(20);
    // StepMode Up=0 / Down=1; 40% is level 102, +25 is 127 = 50%.
    await hb.invoke('light_4', 'levelControl', 'step', { stepMode: 0, stepSize: 25 });
    await hb.invoke('light_4', 'levelControl', 'step', { stepMode: 1, stepSize: 254 });
    assert.deepEqual(ws.calls, [['dimLight', 'light_4', 50], ['dimLight', 'light_4', 1]]);
});

test('LevelControl step on a light that is off does not turn it on', async () => {
    const { hb, ws } = await setup(light({ on: false, dimmable: true, brightness: 40 }));
    await hb.invoke('light_4', 'levelControl', 'step', { stepMode: 0, stepSize: 25 });
    assert.deepEqual(ws.calls, []);
});

test('LevelControl stop is accepted and move is refused as an unsupported command', async () => {
    const { hb, ws } = await setup(light({ on: true, dimmable: true, brightness: 40 }));
    await hb.invoke('light_4', 'levelControl', 'stop', {});
    await assert.rejects(
        () => hb.invoke('light_4', 'levelControl', 'move', { moveMode: 0, rate: 50 }),
        (err) => err.code === UNSUPPORTED_COMMAND,
    );
    assert.deepEqual(ws.calls, []);
});

test('moveToLevel at the minimum level keeps the light on; only the WithOnOff variant turns it off', async () => {
    const { hb, ws } = await setup(light({ on: true, dimmable: true, brightness: 40 }));
    await hb.invoke('light_4', 'levelControl', 'moveToLevel', { level: 1 });
    await hb.invoke('light_4', 'levelControl', 'moveToLevelWithOnOff', { level: 1 });
    await hb.invoke('light_4', 'levelControl', 'moveToLevelWithOnOff', { level: 254 });
    assert.deepEqual(ws.calls, [['dimLight', 'light_4', 1], ['dimLight', 'light_4', 0], ['dimLight', 'light_4', 100]]);
});

test('WindowCovering upOrOpen / downOrClose drive the cover fully open / closed', async () => {
    const { hb, ws } = await setup(cover({ position: 40, targetPosition: 40, state: 'stopped' }));
    await hb.invoke('cover_9', 'windowCovering', 'upOrOpen');
    await hb.invoke('cover_9', 'windowCovering', 'downOrClose');
    assert.deepEqual(ws.calls, [['moveCover', 'cover_9', 100], ['moveCover', 'cover_9', 0]]);
});

test('WindowCovering stopMotion is a no-op on a stopped cover and refused while it moves', async () => {
    const { hb, ws, registry } = await setup(cover({ position: 40, targetPosition: 40, state: 'stopped' }));
    await hb.invoke('cover_9', 'windowCovering', 'stopMotion');
    await registry.updateAccessoryState(cover({ position: 40, targetPosition: 100, state: 'opening' }));
    await delay(20);
    await assert.rejects(
        () => hb.invoke('cover_9', 'windowCovering', 'stopMotion'),
        (err) => err.code === UNSUPPORTED_COMMAND,
    );
    assert.deepEqual(ws.calls, []);
});
