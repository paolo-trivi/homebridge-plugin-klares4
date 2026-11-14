'use strict';

// Matter commands on the real Homebridge stack: what the controller sees after
// a cover command (MAT-05), a level command on a dimmer that is off (MAT-08)
// and any command while the panel client is missing (MAT-15).

const test = require('node:test');
const assert = require('node:assert/strict');

const { deviceToMatterAccessory } = require('../dist/platform/matter-device-mapper.js');
const { buildStateUpdates } = require('../dist/platform/matter-state-updates.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');
const { waitFor } = require('./fixtures/wait-for.js');

const PLUGIN = 'homebridge-plugin-klares4';
const PLATFORM = 'Lares4Complete';
const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });

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

async function register(stack, device, getWsClient) {
    const accessory = deviceToMatterAccessory(device, {
        api: stack.api, log: silentLog(), getWsClient, momentaryAutoOffMs: 5, getLatestDevice: () => device,
    });
    await stack.api.matter.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
    assert.ok(stack.record(device.id), `${device.id} registered`);
}

const lift = (stack, uuid) => {
    const state = stack.read(uuid, 'windowCovering');
    return { current: state.currentPositionLiftPercent100ths, target: state.targetPositionLiftPercent100ths };
};
// WindowCovering MovementStatus: 0 stopped, 1 opening, 2 closing.
const movement = (stack, uuid) => stack.read(uuid, 'windowCovering').operationalStatus.lift;

for (const [command, args, panelTarget, matterTarget, moving] of [
    ['upOrOpen', undefined, 100, 0, 1],
    ['downOrClose', undefined, 0, 10000, 2],
    ['goToLiftPercentage', { liftPercent100thsValue: 2500 }, 75, 2500, 1],
]) {
    test(`MAT-05: after ${command} the cover keeps its reported position and shows the requested target`, { timeout: 30000 }, async (t) => {
        const stack = await realMatterStackSession(t).start();
        const ws = wsClient();
        // Half open: panel 50 = Matter 5000.
        const cover = { id: 'cover_1', type: 'cover', name: 'Tenda prova', description: '', status: { position: 50, targetPosition: 50, state: 'stopped' } };
        await register(stack, cover, () => ws);
        assert.deepEqual(lift(stack, 'cover_1'), { current: 5000, target: 5000 });

        await stack.invoke('cover_1', 'windowCovering', command, args);
        assert.deepEqual(ws.calls, [['moveCover', 'cover_1', panelTarget]]);
        // matter.js moves `current` to the target as part of the command; the
        // plugin puts the reported position back once the command has committed.
        await waitFor(() => lift(stack, 'cover_1').current === 5000);
        assert.deepEqual(lift(stack, 'cover_1'), { current: 5000, target: matterTarget });
        assert.equal(movement(stack, 'cover_1'), moving, 'controllers see the cover moving');
        await stack.settle();
        assert.deepEqual(lift(stack, 'cover_1'), { current: 5000, target: matterTarget });
    });
}

test('MAT-05: the panel statuses that follow the command drive the position', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const ws = wsClient();
    const cover = { id: 'cover_2', type: 'cover', name: 'Tenda due', description: '', status: { position: 0, targetPosition: 0, state: 'stopped' } };
    await register(stack, cover, () => ws);
    await stack.invoke('cover_2', 'windowCovering', 'upOrOpen');
    await waitFor(() => lift(stack, 'cover_2').current === 10000);
    assert.deepEqual(lift(stack, 'cover_2'), { current: 10000, target: 0 }, 'closed, opening requested');

    // First STATUS_OUTPUTS of the movement (POS=10 TPOS=100), as the registry pushes it.
    cover.status = { position: 10, targetPosition: 100, state: 'opening' };
    for (const update of buildStateUpdates(cover)) {
        await stack.api.matter.updateAccessoryState('cover_2', update.clusterName, update.attributes);
    }
    await waitFor(() => lift(stack, 'cover_2').current === 9000);
    assert.deepEqual(lift(stack, 'cover_2'), { current: 9000, target: 0 });
    assert.equal(movement(stack, 'cover_2'), 1);

    // Arrival: the movement status goes back to stopped.
    cover.status = { position: 100, targetPosition: 100, state: 'stopped' };
    for (const update of buildStateUpdates(cover)) {
        await stack.api.matter.updateAccessoryState('cover_2', update.clusterName, update.attributes);
    }
    await waitFor(() => lift(stack, 'cover_2').current === 0);
    assert.deepEqual(lift(stack, 'cover_2'), { current: 0, target: 0 });
    assert.equal(movement(stack, 'cover_2'), 0);
});

test('MAT-08: moveToLevel on a dimmer that is off sends nothing to the panel', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const ws = wsClient();
    const dimmer = { id: 'light_3', type: 'light', name: 'Faretto spento', description: '', status: { on: false, dimmable: true, brightness: 40 } };
    await register(stack, dimmer, () => ws);

    await stack.invoke('light_3', 'levelControl', 'moveToLevel', {
        level: 200, transitionTime: null, optionsMask: {}, optionsOverride: {},
    });
    assert.deepEqual(ws.calls, []);
    assert.equal(stack.read('light_3', 'onOff').onOff, false);

    dimmer.status.on = true;
    await stack.invoke('light_3', 'levelControl', 'moveToLevel', {
        level: 127, transitionTime: null, optionsMask: {}, optionsOverride: {},
    });
    assert.deepEqual(ws.calls, [['dimLight', 'light_3', 50]]);
});

test('MAT-15: without a panel client every command fails and the Matter state does not change', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const noClient = () => undefined;
    await register(stack, { id: 'light_4', type: 'light', name: 'Luce senza client', description: '', status: { on: false, dimmable: false } }, noClient);
    await register(stack, { id: 'cover_5', type: 'cover', name: 'Tenda senza client', description: '', status: { position: 50, state: 'stopped' } }, noClient);
    await register(stack, { id: 'scenario_6', type: 'scenario', name: 'Scenario senza client', description: '', status: { active: false } }, noClient);
    await register(stack, { id: 'gate_7', type: 'gate', name: 'Cancello senza client', description: '', status: { on: false } }, noClient);

    await assert.rejects(stack.invoke('light_4', 'onOff', 'on', {}));
    assert.equal(stack.read('light_4', 'onOff').onOff, false);
    await assert.rejects(stack.invoke('cover_5', 'windowCovering', 'downOrClose'));
    assert.deepEqual(lift(stack, 'cover_5'), { current: 5000, target: 5000 });
    await assert.rejects(stack.invoke('scenario_6', 'onOff', 'on', {}));
    assert.equal(stack.read('scenario_6', 'onOff').onOff, false);
    await assert.rejects(stack.invoke('gate_7', 'onOff', 'on', {}));
    assert.equal(stack.read('gate_7', 'onOff').onOff, false);
});
