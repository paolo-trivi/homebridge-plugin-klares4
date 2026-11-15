'use strict';

// WS-04 / SP-05 (dispatcher side): the per-device command queue has a deadline,
// a depth limit and a policy per kind of output, and nothing queued behind a
// dropped socket is sent later. WS-14: a numeric response ID still correlates.

const test = require('node:test');
const assert = require('node:assert/strict');

const { CommandDispatcher, CommandQueueRejectedError } = require('../dist/websocket/command-dispatcher.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { settle } = require('./fixtures/command-client.js');

/** A command that runs until `release()` is called. */
function gatedCommand(log, name) {
    let release;
    const done = new Promise((resolve) => { release = resolve; });
    return { run: async () => { log.push(name); await done; }, release: () => release() };
}

const rejectedFor = (reason) => (error) => error instanceof CommandQueueRejectedError && error.reason === reason;

test('reject-while-busy: a second momentary command is refused at once, never sent later', async () => {
    const dispatcher = new CommandDispatcher();
    const ran = [];
    const first = gatedCommand(ran, 'first');
    const a = dispatcher.enqueueDeviceCommand('gate_9', first.run, { policy: 'reject-while-busy' });
    const b = settle(dispatcher.enqueueDeviceCommand('gate_9', async () => { ran.push('second'); }, { policy: 'reject-while-busy' }));
    const result = await b;
    assert.equal(result.ok, false);
    assert.ok(rejectedFor('busy')(result.error), String(result.error));
    first.release();
    await a;
    assert.deepEqual(ran, ['first']);
    // Free again: the next press is accepted.
    await dispatcher.enqueueDeviceCommand('gate_9', async () => { ran.push('third'); }, { policy: 'reject-while-busy' });
    assert.deepEqual(ran, ['first', 'third']);
});

test('latest-wins: replaced requests are never run and share the outcome of the one that replaced them', async () => {
    const dispatcher = new CommandDispatcher();
    const ran = [];
    const first = gatedCommand(ran, 'on');
    const opts = { policy: 'latest-wins', maxWaitMs: 5000 };
    const a = dispatcher.enqueueDeviceCommand('light_5', first.run, opts);
    let bSettled = false;
    const b = dispatcher.enqueueDeviceCommand('light_5', async () => { ran.push('off'); }, opts);
    b.then(() => { bSettled = true; }, () => { bSettled = true; });
    const last = gatedCommand(ran, 'on-again');
    const c = dispatcher.enqueueDeviceCommand('light_5', last.run, opts);
    first.release();
    await a;
    await waitFor(() => ran.length === 2);
    assert.equal(bSettled, false, 'a replaced request does not settle before the command that replaced it');
    last.release();
    await Promise.all([b, c]);
    assert.deepEqual(ran, ['on', 'on-again']);
});

test('latest-wins: replaced requests fail when the command that replaced them fails', async () => {
    const dispatcher = new CommandDispatcher();
    const first = gatedCommand([], 'first');
    const opts = { policy: 'latest-wins', maxWaitMs: 5000 };
    const a = dispatcher.enqueueDeviceCommand('cover_7', first.run, opts);
    const replaced = [1, 2, 3].map(() => settle(dispatcher.enqueueDeviceCommand('cover_7', async () => undefined, opts)));
    const last = settle(dispatcher.enqueueDeviceCommand('cover_7', async () => { throw new Error('refused by panel'); }, opts));
    first.release();
    await a;
    for (const result of await Promise.all([...replaced, last])) {
        assert.equal(result.ok, false);
        assert.match(result.error.message, /refused by panel/);
    }
});

test('a command left in the queue beyond its deadline is refused and never runs', async () => {
    const dispatcher = new CommandDispatcher();
    const ran = [];
    const first = gatedCommand(ran, 'first');
    const a = dispatcher.enqueueDeviceCommand('cover_7', first.run, { policy: 'latest-wins', maxWaitMs: 20 });
    const b = await settle(dispatcher.enqueueDeviceCommand('cover_7', async () => { ran.push('late'); }, { policy: 'latest-wins', maxWaitMs: 20 }));
    assert.ok(rejectedFor('expired')(b.error), String(b.error));
    first.release();
    await a;
    assert.deepEqual(ran, ['first']);
});

test('the queue depth is capped', async () => {
    const dispatcher = new CommandDispatcher();
    const ran = [];
    const first = gatedCommand(ran, '1');
    const opts = { maxDepth: 2 };
    const a = dispatcher.enqueueDeviceCommand('thermostat-cfg:1', first.run, opts);
    const b = dispatcher.enqueueDeviceCommand('thermostat-cfg:1', async () => { ran.push('2'); }, opts);
    const c = dispatcher.enqueueDeviceCommand('thermostat-cfg:1', async () => { ran.push('3'); }, opts);
    const d = await settle(dispatcher.enqueueDeviceCommand('thermostat-cfg:1', async () => { ran.push('4'); }, opts));
    assert.ok(rejectedFor('queue-full')(d.error), String(d.error));
    first.release();
    await Promise.all([a, b, c]);
    assert.deepEqual(ran, ['1', '2', '3']);
});

test('a failing command does not block the queue; every queue is released afterwards', async () => {
    const dispatcher = new CommandDispatcher();
    const a = settle(dispatcher.enqueueDeviceCommand('light_5', async () => { throw new Error('boom'); }));
    const b = dispatcher.enqueueDeviceCommand('light_5', async () => 'ok');
    assert.equal((await a).ok, false);
    await b;
    assert.equal(dispatcher.queuedCommandCount('light_5'), 0);
});

test('a dropped socket rejects the waiting commands too: none is sent after a reconnect', async () => {
    const dispatcher = new CommandDispatcher();
    const ran = [];
    const first = gatedCommand(ran, 'first');
    const a = settle(dispatcher.enqueueDeviceCommand('thermostat-cfg:2', first.run));
    const b = settle(dispatcher.enqueueDeviceCommand('thermostat-cfg:2', async () => { ran.push('queued'); }));
    dispatcher.rejectAllPendingCommands(new Error('WebSocket closed (1006 - No reason)'));
    const queued = await b;
    assert.equal(queued.ok, false);
    assert.match(queued.error.message, /WebSocket closed/);
    first.release();
    await a;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(ran, ['first']);
});

test('clearCommandQueues rejects the waiting commands', async () => {
    const dispatcher = new CommandDispatcher();
    const ran = [];
    const first = gatedCommand(ran, 'first');
    dispatcher.enqueueDeviceCommand('light_6', first.run).catch(() => undefined);
    const b = settle(dispatcher.enqueueDeviceCommand('light_6', async () => { ran.push('queued'); }));
    dispatcher.clearCommandQueues();
    assert.equal((await b).ok, false);
    first.release();
    await waitFor(() => dispatcher.queuedCommandCount('light_6') === 0);
    assert.deepEqual(ran, ['first']);
});

test('WS-14: a response whose ID is a JSON number correlates exactly with two commands pending', async () => {
    const dispatcher = new CommandDispatcher();
    const a = dispatcher.registerPendingCommand('41', 200, ['CMD_USR_RES'], true, true);
    const b = dispatcher.registerPendingCommand('42', 200, ['CMD_USR_RES'], true, true);
    dispatcher.resolvePendingCommand({ ID: 41, CMD: 'CMD_USR_RES', PAYLOAD: { RESULT: 'OK' } });
    dispatcher.resolvePendingCommand({ ID: 42, CMD: 'CMD_USR_RES', PAYLOAD: { RESULT: 'OK' } });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.correlation, 'exact-id');
    assert.equal(rb.correlation, 'exact-id');
});
