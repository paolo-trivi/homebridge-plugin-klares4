const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OutputCommandConfirmationTracker,
} = require('../dist/websocket/output-command-confirmation.js');

test('confirms only a matching output state', async () => {
  const tracker = new OutputCommandConfirmationTracker();
  const handle = tracker.register('12', 500, (status) => status.STA === 'ON');

  tracker.observe({ ID: '11', STA: 'ON' });
  tracker.observe({ ID: '12', STA: 'OFF' });
  tracker.observe({ ID: '12', STA: 'ON' });

  const result = await handle.promise;
  assert.equal(result.status, 'state-confirmed');
  assert.ok(result.latencyMs >= 0);
});

test('times out when no matching state arrives', async () => {
  const tracker = new OutputCommandConfirmationTracker();
  const handle = tracker.register('12', 5, () => false);

  await assert.rejects(handle.promise, /timed out/);
});

test('rejects duplicate confirmations for one output', () => {
  const tracker = new OutputCommandConfirmationTracker();
  const first = tracker.register('12', 500, () => false);

  assert.throws(() => tracker.register('12', 500, () => false), /already has/);
  first.cancel();
});

test('cancel removes a pending confirmation without settling it', () => {
  const tracker = new OutputCommandConfirmationTracker();
  const first = tracker.register('12', 500, () => false);
  first.cancel();

  const second = tracker.register('12', 500, () => true);
  tracker.observe({ ID: '12', STA: 'ON' });
  return second.promise;
});

test('rejectAll rejects every pending confirmation', async () => {
  const tracker = new OutputCommandConfirmationTracker();
  const first = tracker.register('12', 500, () => false);
  const second = tracker.register('13', 500, () => false);

  tracker.rejectAll(new Error('disconnected'));

  await assert.rejects(first.promise, /disconnected/);
  await assert.rejects(second.promise, /disconnected/);
});
