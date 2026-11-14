const test = require('node:test');
const assert = require('node:assert/strict');

const { CommandService } = require('../dist/websocket-client/command-service.js');
const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');
const { CommandDispatcher } = require('../dist/websocket/command-dispatcher.js');
const { OutputCommandConfirmationTracker } = require('../dist/websocket/output-command-confirmation.js');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createService(onSend) {
    const state = createInitialWebSocketClientState();
    state.idLogin = '5';
    state.ws = { readyState: 1 };
    const dispatcher = new CommandDispatcher();
    const outputConfirmation = new OutputCommandConfirmationTracker();
    const service = new CommandService({
        state, sender: 'hb', pin: '0000', log: silentLog, logLevel: 0,
        options: { commandTimeoutMs: 30 },
        commandDispatcher: dispatcher,
        outputConfirmation,
        wsTransport: { send: async () => { await onSend?.(dispatcher, outputConfirmation); } },
        emitRawMessage: () => undefined,
    });
    return { service, dispatcher, outputConfirmation };
}

async function collectUnhandled(run) {
    const unhandled = [];
    const listener = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
        await run();
        // Past the ACK timeout, when an orphaned promise would reject.
        await wait(80);
    } finally {
        process.off('unhandledRejection', listener);
    }
    return unhandled;
}

test('F23: a failing state-confirmation registration leaves no orphaned ACK promise', async () => {
    const h = createService();
    // Output 7 already awaits a confirmation (e.g. same output under another queue key).
    const other = h.outputConfirmation.register('7', 1000, () => false);
    other.promise.catch(() => undefined);
    const unhandled = await collectUnhandled(async () => {
        await assert.rejects(() => h.service.switchLight('light_7', true), /already has a pending state confirmation/);
    });
    other.cancel();
    assert.deepEqual(unhandled, []);
});

test('F23: a confirmation rejected by a disconnect during the send is not unhandled', async () => {
    const h = createService(async (dispatcher, outputConfirmation) => {
        outputConfirmation.rejectAll(new Error('WebSocket disconnected'));
        dispatcher.rejectAllPendingCommands(new Error('WebSocket closed'));
        await wait(10);
    });
    const unhandled = await collectUnhandled(async () => {
        await assert.rejects(() => h.service.switchLight('light_7', true), /WebSocket/);
    });
    assert.deepEqual(unhandled, []);
});
