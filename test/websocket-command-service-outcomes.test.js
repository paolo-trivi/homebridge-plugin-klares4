const test = require('node:test');
const assert = require('node:assert/strict');

const { CommandService } = require('../dist/websocket-client/command-service.js');
const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');
const { CommandDispatcher } = require('../dist/websocket/command-dispatcher.js');
const { OutputCommandConfirmationTracker } = require('../dist/websocket/output-command-confirmation.js');
const { PanelCommandRejectedError, RetryableKlaresError } = require('../dist/errors.js');

function createService(onSend, timeoutMs = 40) {
  const state = createInitialWebSocketClientState();
  state.idLogin = 'login-id';
  state.ws = { readyState: 1 };
  const dispatcher = new CommandDispatcher();
  const outputConfirmation = new OutputCommandConfirmationTracker();
  const logs = [];
  const log = {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
    debug: (message) => logs.push(['debug', message]),
    error: (message) => logs.push(['error', message]),
  };
  const sent = [];
  const service = new CommandService({
    state,
    sender: 'test-sender',
    pin: 'secret',
    log,
    logLevel: 0,
    options: { commandTimeoutMs: timeoutMs },
    commandDispatcher: dispatcher,
    outputConfirmation,
    wsTransport: {
      send: async (_socket, raw) => {
        const message = JSON.parse(raw);
        sent.push(message);
        await onSend?.(message, dispatcher, outputConfirmation);
      },
    },
    emitRawMessage: () => {},
  });
  return { service, dispatcher, outputConfirmation, sent, logs };
}

test('light mutation resolves only after a positive panel acknowledgement', async () => {
  const harness = createService((message, dispatcher) => {
    setImmediate(() => dispatcher.resolvePendingCommand({
      ID: message.ID,
      CMD: 'CMD_USR_RES',
      PAYLOAD: { RESULT: 'OK' },
    }));
  });

  await harness.service.switchLight('light_7', true);

  assert.equal(harness.sent[0].PAYLOAD.OUTPUT.ID, '7');
  assert.equal(harness.sent[0].PAYLOAD.OUTPUT.STA, 'ON');
  assert.ok(harness.logs.some(([level, message]) => level === 'info' && message.includes('acknowledged')));
});

test('negative panel result rejects the public mutation promise', async () => {
  const harness = createService((message, dispatcher) => {
    setImmediate(() => dispatcher.resolvePendingCommand({
      ID: message.ID,
      CMD: 'CMD_USR_RES',
      PAYLOAD: { RESULT: 'FAIL', RESULT_DETAIL: 'CMD_NOT_AVAILABLE' },
    }));
  });

  await assert.rejects(
    harness.service.triggerScenario('scenario_14'),
    (error) => error instanceof PanelCommandRejectedError && error.detail === 'CMD_NOT_AVAILABLE',
  );
  assert.equal(harness.logs.some(([, message]) => message.includes('executed')), false);
});

test('observable output mutation may resolve from a matching realtime update', async () => {
  let commandId;
  const harness = createService((message, _dispatcher, outputConfirmation) => {
    commandId = message.ID;
    setImmediate(() => outputConfirmation.observe({ ID: '7', STA: 'ON' }));
  });

  await harness.service.switchLight('light_7', true);

  assert.equal(harness.dispatcher.hasPendingCommand(commandId), false);
  assert.ok(harness.logs.some(([level, message]) => level === 'info' && message.includes('state-confirmed')));
});

test('gate mutation rejects on timeout because no physical state is invented', async () => {
  const harness = createService(undefined, 15);

  await assert.rejects(
    harness.service.toggleGate('gate_29'),
    (error) => error instanceof RetryableKlaresError && error.message.includes('timed out'),
  );
  assert.equal(harness.logs.some(([, message]) => message.includes('acknowledged')), false);
});
