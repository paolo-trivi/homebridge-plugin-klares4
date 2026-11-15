'use strict';

// NEW-1 (rc.1 review): Matter commands in quick succession on the same
// endpoint, on the real Homebridge stack, through the registry (the path of
// production). Every command must reach the panel exactly once and succeed
// for the controller; a plugin state push must not make a later command fail
// with matter.js's "Cannot lock" while the panel already executed it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const TIMINGS = { registerProbeTimeoutMs: 5000, registerProbePollMs: 10, registerProbePollMaxMs: 50, stateBootstrapMs: 0 };
const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function setup(t, device) {
    const stack = await realMatterStackSession(t).start();
    // State pushes Homebridge is still applying (StateManager defers each one).
    let inFlight = 0;
    const apply = stack.server.updateAccessoryState.bind(stack.server);
    t.mock.method(stack.server, 'updateAccessoryState', async (...args) => {
        inFlight += 1;
        try {
            return await apply(...args);
        } finally {
            inFlight -= 1;
        }
    });
    const ws = wsClient();
    const registry = new MatterAccessoryRegistry({
        api: stack.api, log: silentLog(), getWsClient: () => ws, storagePath: tmpStorage(t, 'klares4-burst-'), timings: TIMINGS,
    });
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(device);
    await waitFor(() => registry.getStatus(device.id) === 'registered', 10000);
    // The burst starts once the registration's own state pushes are done: a
    // push in flight makes any command fail with "Cannot lock" (see NEW-1 above).
    await waitFor(() => registry.getPendingCount(device.id) === 0 && inFlight === 0, 10000);
    return { stack, ws };
}

async function burst(stack, uuid, cluster, commands, gapMs) {
    const outcomes = [];
    for (const [command, args] of commands) {
        try {
            await stack.invoke(uuid, cluster, command, args);
            outcomes.push(`${command}:ok`);
        } catch (error) {
            outcomes.push(`${command}:ERR ${String(error.message).replace(/\s+/g, ' ').slice(0, 80)}`);
        }
        if (gapMs) await sleep(gapMs);
    }
    return outcomes;
}

const COVER_SEQUENCE = [
    ['upOrOpen'], ['downOrClose'], ['goToLiftPercentage', { liftPercent100thsValue: 2500 }], ['upOrOpen'], ['downOrClose'],
];

for (const gapMs of [0, 1, 5]) {
    // The position refresh after a cover command now takes the state-update
    // queue, but a push in flight still holds the endpoint when the next
    // command arrives: measured on Homebridge 2.5, 0 and 1 ms fail with
    // "Cannot lock" without the per-endpoint serialization of plugin pushes
    // against controller commands that task E adds to the queue
    // (matter-state-update-queue.ts). Enable when that lands.
    test(`NEW-1: cover commands ${gapMs} ms apart all succeed and each reaches the panel once`, {
        timeout: 120000,
        todo: 'NEW-1: needs the per-endpoint serialization of state pushes against commands (task E, matter-state-update-queue.ts)',
    }, async (t) => {
        // At rest half open, so every command is a real movement (stopMotion is refused while moving).
        const cover = { id: 'cover_1', type: 'cover', name: 'Tenda raffica', description: '', status: { position: 50, targetPosition: 50, state: 'stopped' } };
        const { stack, ws } = await setup(t, cover);

        const outcomes = await burst(stack, 'cover_1', 'windowCovering', COVER_SEQUENCE, gapMs);
        assert.deepEqual(outcomes, COVER_SEQUENCE.map(([c]) => `${c}:ok`));
        assert.deepEqual(ws.calls.map((c) => c[2]), [100, 0, 75, 100, 0], 'each command sent once, in order');

        // The panel has not reported any movement: current stays at the reported 50 %, target is the last request.
        await waitFor(() => {
            const state = stack.read('cover_1', 'windowCovering');
            return state.currentPositionLiftPercent100ths === 5000 && state.targetPositionLiftPercent100ths === 10000;
        });
    });
}

test('NEW-1: stopMotion right after a refresh push succeeds when the cover is at rest', { timeout: 120000 }, async (t) => {
    const cover = { id: 'cover_2', type: 'cover', name: 'Tenda ferma', description: '', status: { position: 50, targetPosition: 50, state: 'stopped' } };
    const { stack, ws } = await setup(t, cover);
    const outcomes = await burst(stack, 'cover_2', 'windowCovering', [['goToLiftPercentage', { liftPercent100thsValue: 5000 }], ['stopMotion']], 0);
    assert.deepEqual(outcomes, ['goToLiftPercentage:ok', 'stopMotion:ok']);
    assert.deepEqual(ws.calls, [['moveCover', 'cover_2', 50]]);
});

for (const gapMs of [0, 1, 5]) {
    test(`NEW-1: light and dimmer commands ${gapMs} ms apart all succeed and each reaches the panel once`, { timeout: 120000 }, async (t) => {
        const dimmer = { id: 'light_3', type: 'light', name: 'Faretto raffica', description: '', status: { on: true, dimmable: true, brightness: 40 } };
        const { stack, ws } = await setup(t, dimmer);
        const level = (value) => ['moveToLevel', { level: value, transitionTime: null, optionsMask: {}, optionsOverride: {} }];

        const onOff = await burst(stack, 'light_3', 'onOff', [['off', {}], ['on', {}], ['off', {}], ['on', {}]], gapMs);
        assert.deepEqual(onOff, ['off:ok', 'on:ok', 'off:ok', 'on:ok']);
        const levels = await burst(stack, 'light_3', 'levelControl', [level(127), level(254), level(64)], gapMs);
        assert.deepEqual(levels, ['moveToLevel:ok', 'moveToLevel:ok', 'moveToLevel:ok']);
        assert.deepEqual(ws.calls.map((c) => c[0]), ['switchLight', 'switchLight', 'switchLight', 'switchLight', 'dimLight', 'dimLight', 'dimLight']);
    });
}
