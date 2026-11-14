const test = require('node:test');
const assert = require('node:assert/strict');

const { CommandService } = require('../dist/websocket-client/command-service.js');
const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');
const { CommandDispatcher } = require('../dist/websocket/command-dispatcher.js');
const { OutputCommandConfirmationTracker } = require('../dist/websocket/output-command-confirmation.js');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function createService(onSend) {
    const state = createInitialWebSocketClientState();
    state.idLogin = '5';
    state.ws = { readyState: 1 };
    const dispatcher = new CommandDispatcher();
    const sent = [];
    const service = new CommandService({
        state, sender: 'hb', pin: '0000', log: silentLog, logLevel: 0,
        options: { commandTimeoutMs: 200 },
        commandDispatcher: dispatcher,
        outputConfirmation: new OutputCommandConfirmationTracker(),
        wsTransport: {
            send: async (_ws, raw) => {
                const message = JSON.parse(raw);
                sent.push(message);
                onSend?.(message, dispatcher);
            },
        },
        emitRawMessage: () => undefined,
    });
    return { service, dispatcher, sent };
}

function readFail(id, payloadType) {
    return {
        ID: id, CMD: 'READ_RES', PAYLOAD_TYPE: payloadType,
        PAYLOAD: { RESULT: 'FAIL', RESULT_DETAIL: 'CMD_NOT_AVAILABLE' },
    };
}

test('the READ_RES FAIL for PRG_THERMOSTATS sent at login does not reject a pending gate command', async () => {
    const h = createService();
    const gate = h.service.toggleGate('gate_29');
    await new Promise((resolve) => setImmediate(resolve));
    const gateId = h.sent[0].ID;

    await h.service.requestSystemData();
    const prgRead = h.sent.find((m) => m.CMD === 'READ' && m.PAYLOAD_TYPE === 'PRG_THERMOSTATS');
    h.dispatcher.resolvePendingCommand(readFail(prgRead.ID, 'PRG_THERMOSTATS'));
    h.dispatcher.resolvePendingCommand({ ID: gateId, CMD: 'CMD_USR_RES', PAYLOAD_TYPE: 'REPLY', PAYLOAD: { RESULT: 'OK' } });

    await gate;
});

test('every command ID the plugin sends is known to the dispatcher and fits 16 bits', async () => {
    const h = createService();
    await h.service.requestSystemData();
    assert.ok(h.sent.length >= 7);
    for (const message of h.sent) {
        assert.equal(h.dispatcher.isKnownCommandId(message.ID), true, message.PAYLOAD_TYPE);
        const numeric = Number(message.ID);
        // The panel echoes IDs modulo 65536: larger IDs could never be matched exactly.
        assert.ok(Number.isInteger(numeric) && numeric >= 1 && numeric <= 65535, message.ID);
    }
});

test('an unsolicited typed response never settles a pending command of another type', async () => {
    const dispatcher = new CommandDispatcher();
    const gate = dispatcher.registerPendingCommand('100', 80, ['CMD_USR_RES'], true, true);
    let gateOutcome = 'pending';
    gate.then(() => { gateOutcome = 'resolved'; }, (error) => { gateOutcome = error.message; });

    // Unknown ID, typed as a READ response: not an answer to CMD_USR.
    dispatcher.resolvePendingCommand(readFail('4242', 'PRG_THERMOSTATS'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gateOutcome, 'pending');

    // An untyped error with an unknown ID is still attributed to the only candidate.
    dispatcher.resolvePendingCommand({ ID: '4243', CMD: 'GENERIC', PAYLOAD_TYPE: 'ERROR', PAYLOAD: { RESULT: 'FAIL' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(gateOutcome, 'pending');
    assert.notEqual(gateOutcome, 'resolved');
});

test('a pending CFG_THERMOSTATS read is not resolved by an unrelated READ_RES with an unknown ID', async () => {
    const dispatcher = new CommandDispatcher();
    const prime = dispatcher.registerPendingCommand('200', 80, ['READ_RES'], false, false, ['CFG_THERMOSTATS']);
    let outcome = 'pending';
    prime.then((ack) => { outcome = ack.correlation; }, (error) => { outcome = error.message; });

    dispatcher.resolvePendingCommand({ ID: '9001', CMD: 'READ_RES', PAYLOAD_TYPE: 'STATUS_OUTPUTS', PAYLOAD: { RESULT: 'OK' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outcome, 'pending');

    // Same payload type from a firmware that answers with another ID: still accepted.
    dispatcher.resolvePendingCommand({ ID: '9002', CMD: 'READ_RES', PAYLOAD_TYPE: 'CFG_THERMOSTATS', PAYLOAD: { RESULT: 'OK' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outcome, 'single-compatible');
});

test('a fire-and-forget READ response is ignored even while a read of the same kind is pending', async () => {
    const dispatcher = new CommandDispatcher();
    dispatcher.noteFireAndForget('300');
    const prime = dispatcher.registerPendingCommand('301', 60, ['READ_RES'], false, false, ['CFG_THERMOSTATS']);
    let outcome = 'pending';
    prime.then((ack) => { outcome = ack.correlation; }, () => { outcome = 'rejected'; });

    dispatcher.resolvePendingCommand({ ID: '300', CMD: 'READ_RES', PAYLOAD_TYPE: 'CFG_THERMOSTATS', PAYLOAD: { RESULT: 'OK' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outcome, 'pending');
    dispatcher.clearPendingCommand('301');
});
