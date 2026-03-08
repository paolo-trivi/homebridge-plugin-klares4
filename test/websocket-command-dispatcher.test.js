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
