'use strict';

// NEW-1 follow-up: a push that arrives when no command runs must not overtake
// an older push of the same cluster that a command held in the queue; the
// older one, flushed later, would overwrite the newer value (seen on a cover:
// the target of the previous command came back after the last one).

const test = require('node:test');
const assert = require('node:assert/strict');

const { MatterStateUpdateQueue } = require('../dist/platform/matter-state-update-queue.js');
const { waitFor } = require('./fixtures/wait-for.js');

test('a push never overtakes an older queued push of the same endpoint', async () => {
    const pushed = [];
    const api = { matter: {
        updateAccessoryState: async (uuid, cluster, attributes) => { pushed.push(attributes.targetPositionLiftPercent100ths); },
        getAccessoryState: async () => undefined,
    } };
    const reg = {
        uuid: 'cover_1', displayName: 'Tenda', status: 'registered', pendingStateUpdates: [],
        matterAccessory: { UUID: 'cover_1', clusters: { windowCovering: {} }, handlers: {} },
    };
    const queue = new MatterStateUpdateQueue(api, { info() {}, warn() {}, debug() {}, error() {} }, new Map([['cover_1', reg]]), String);

    // A command runs on the endpoint: the first push waits in the queue.
    let finish;
    const guarded = queue.commands.guard({
        UUID: 'cover_1',
        clusters: reg.matterAccessory.clusters,
        handlers: { windowCovering: { upOrOpen: () => new Promise((resolve) => { finish = resolve; }) } },
    });
    const command = guarded.handlers.windowCovering.upOrOpen();
    await queue.pushOrQueue(reg, { clusterName: 'windowCovering', attributes: { targetPositionLiftPercent100ths: 0 } });
    assert.deepEqual(pushed, []);
    finish();
    await command;
    await waitFor(() => !queue.commands.isBusy('cover_1'));

    // The command is over, the first push is still queued: the newer one goes behind it.
    await queue.pushOrQueue(reg, { clusterName: 'windowCovering', attributes: { targetPositionLiftPercent100ths: 10000 } });
    await waitFor(() => reg.pendingStateUpdates.length === 0 && pushed.length > 0);
    assert.equal(pushed.at(-1), 10000, `pushed in this order: ${pushed.join(', ')}`);
});
