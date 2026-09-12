const test = require('node:test');
const assert = require('node:assert/strict');

const { CommandDispatcher } = require('../dist/websocket/command-dispatcher.js');

test('CommandDispatcher serializes commands per device', async () => {
  const dispatcher = new CommandDispatcher();
  const events = [];

  const first = dispatcher.enqueueDeviceCommand('light_1', async () => {
    events.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 30));
    events.push('first-end');
  });

  const second = dispatcher.enqueueDeviceCommand('light_1', async () => {
    events.push('second-start');
    events.push('second-end');
  });

  await Promise.all([first, second]);

  assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('CommandDispatcher resolves pending command on expected response', async () => {
  const dispatcher = new CommandDispatcher();
  const pending = dispatcher.registerPendingCommand('42', 500, ['WRITE_RES']);

  dispatcher.resolvePendingCommand({ ID: '42', CMD: 'WRITE_RES' });

  await pending;
  assert.ok(true);
});

test('CommandDispatcher resolves single compatible pending command when response ID mismatches', async () => {
  const dispatcher = new CommandDispatcher();
  const pending = dispatcher.registerPendingCommand('42', 500, ['WRITE_RES']);

  dispatcher.resolvePendingCommand({ ID: '999', CMD: 'WRITE_RES' });

  await pending;
  assert.ok(true);
});

test('CommandDispatcher does not resolve on mismatched ID when multiple compatible pending commands exist', async () => {
  const dispatcher = new CommandDispatcher();
  const pendingA = dispatcher.registerPendingCommand('42', 500, ['WRITE_RES']);
  const pendingB = dispatcher.registerPendingCommand('43', 500, ['WRITE_RES']);

  dispatcher.resolvePendingCommand({ ID: '999', CMD: 'WRITE_RES' });

  await assert.rejects(Promise.all([pendingA, pendingB]), /timed out/);
});

test('CommandDispatcher rejects on timeout', async () => {
  const dispatcher = new CommandDispatcher();

  await assert.rejects(
    dispatcher.registerPendingCommand('99', 5, ['CMD_USR_RES']),
    /timed out/,
  );
});

test('CommandDispatcher rejects all pending commands on disconnect', async () => {
  const dispatcher = new CommandDispatcher();
  const pending = dispatcher.registerPendingCommand('100', 1000, ['CMD_USR_RES']);

  dispatcher.rejectAllPendingCommands(new Error('Client disconnected'));

  await assert.rejects(pending, /Client disconnected/);
});

test('CommandDispatcher rejects an exact response with RESULT=FAIL', async () => {
  const dispatcher = new CommandDispatcher();
  const pending = dispatcher.registerPendingCommand('101', 500, ['WRITE_CFG_RES'], true);

  dispatcher.resolvePendingCommand({
    ID: '101',
    CMD: 'WRITE_CFG_RES',
    PAYLOAD_TYPE: 'CFG_ALL',
    PAYLOAD: { RESULT: 'FAIL', RESULT_DETAIL: 'CMD_NOT_AVAILABLE' },
  });

  await assert.rejects(pending, /CMD_NOT_AVAILABLE/);
});

test('CommandDispatcher requires RESULT=OK when requested', async () => {
  const dispatcher = new CommandDispatcher();
  const pending = dispatcher.registerPendingCommand('102', 500, ['WRITE_CFG_RES'], true);

  dispatcher.resolvePendingCommand({ ID: '102', CMD: 'WRITE_CFG_RES', PAYLOAD: {} });

  await assert.rejects(pending, /did not contain RESULT=OK/);
});

test('CommandDispatcher reports exact and compatible correlation', async () => {
  const dispatcher = new CommandDispatcher();
  const exact = dispatcher.registerPendingCommand('103', 500, ['WRITE_RES']);
  dispatcher.resolvePendingCommand({ ID: '103', CMD: 'WRITE_RES' });
  assert.equal((await exact).correlation, 'exact-id');

  const compatible = dispatcher.registerPendingCommand('104', 500, ['WRITE_RES']);
  dispatcher.resolvePendingCommand({ ID: 'different', CMD: 'WRITE_RES' });
  assert.equal((await compatible).correlation, 'single-compatible');
});

test('CommandDispatcher rejects a safely correlated generic error', async () => {
  const dispatcher = new CommandDispatcher();
  const pending = dispatcher.registerPendingCommand(
    '105', 500, ['CMD_USR_RES'], true, true,
  );

  dispatcher.resolvePendingCommand({
    ID: 'different',
    CMD: 'GENERIC',
    PAYLOAD_TYPE: 'ERROR',
    PAYLOAD: { RESULT: 'FAIL', RESULT_DETAIL: 'CMD_NOT_AVAILABLE' },
  });

  await assert.rejects(pending, /CMD_NOT_AVAILABLE/);
});

test('CommandDispatcher rejects duplicate pending IDs', async () => {
  const dispatcher = new CommandDispatcher();
  const first = dispatcher.registerPendingCommand('106', 500, ['WRITE_RES']);
  await assert.rejects(
    dispatcher.registerPendingCommand('106', 500, ['WRITE_RES']),
    /already pending/,
  );
  dispatcher.resolvePendingCommand({ ID: '106', CMD: 'WRITE_RES' });
  await first;
});
