'use strict';

// MQTT commands: one running and one waiting per device (SP-05), payload
// validation and safe logging (SP-15).

const test = require('node:test');
const assert = require('node:assert/strict');

const { CommandExecutor } = require('../dist/mqtt-bridge/command-executor.js');
const { ValidationKlaresError } = require('../dist/errors.js');
const { ThermostatRoutingError } = require('../dist/websocket-client/thermostat-command-id-resolver.js');
const { recordingLog } = require('./fixtures/fake-mqtt.js');
const { waitFor } = require('./fixtures/wait-for.js');

/** A light whose commands complete only when the test says so. */
function gatedLight({ id = 'light_1', dimmable = true } = {}) {
  const calls = [];
  const gates = [];
  const handler = {
    device: { id, type: 'light', name: 'Luce Uno', status: { on: false, dimmable } },
    setOn: (value) => {
      calls.push(['on', value]);
      return new Promise((resolve) => gates.push(resolve));
    },
    setBrightness: (value) => {
      calls.push(['brightness', value]);
      return new Promise((resolve) => gates.push(resolve));
    },
  };
  const release = () => { const next = gates.shift(); if (next) next(); };
  return { handler, calls, release, gates };
}

function executorFor(handler, log = recordingLog()) {
  return { log, executor: new CommandExecutor({ log: log.logger, findAccessory: () => handler }) };
}

test('SP-05: a flood of commands for one light reaches the accessory at most twice', async () => {
  const light = gatedLight();
  const { executor, log } = executorFor(light.handler);
  for (let i = 0; i < 1000; i++) {
    executor.executeCommand('light', 'light_1', JSON.stringify({ on: i % 2 === 0 }));
  }
  assert.deepEqual(light.calls, [['on', true]], 'the first command runs, the rest wait');
  light.release();
  await waitFor(() => light.calls.length === 2);
  assert.deepEqual(light.calls[1], ['on', false], 'only the latest waiting command runs next');
  light.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(light.calls.length, 2, 'superseded commands are dropped, not executed later');
  const floodWarnings = log.lines.warn.filter((line) => line.includes('faster than the panel'));
  assert.equal(floodWarnings.length, 1, `one warning per burst: ${log.lines.warn.join(' | ')}`);
});

test('SP-05: commands for different devices do not wait for each other', async () => {
  const a = gatedLight({ id: 'light_1' });
  const b = gatedLight({ id: 'light_2' });
  const executor = new CommandExecutor({
    log: recordingLog().logger,
    findAccessory: (type, identifier) => (identifier === 'light_1' ? a.handler : b.handler),
  });
  executor.executeCommand('light', 'light_1', '{"on":true}');
  executor.executeCommand('light', 'light_2', '{"on":true}');
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
});

test('SP-05: after the queue drains a new command runs at once', async () => {
  const light = gatedLight();
  const { executor } = executorFor(light.handler);
  executor.executeCommand('light', 'light_1', '{"on":true}');
  light.release();
  await new Promise((resolve) => setImmediate(resolve));
  executor.executeCommand('light', 'light_1', '{"on":false}');
  assert.deepEqual(light.calls, [['on', true], ['on', false]]);
});

test('SP-05: on and brightness of one command run in sequence, not in parallel', async () => {
  const light = gatedLight();
  const { executor } = executorFor(light.handler);
  executor.executeCommand('light', 'light_1', '{"on":true,"brightness":40}');
  assert.deepEqual(light.calls, [['on', true]]);
  light.release();
  await waitFor(() => light.calls.length === 2);
  assert.deepEqual(light.calls[1], ['brightness', 40]);
});

const rejected = [
  ['an array', '[true]'],
  ['an object without known keys', '{"state":"ON"}'],
  ['a HomeKit-style key', '{"On":true}'],
  ['an empty object', '{}'],
  ['not JSON', 'ON'],
  ['off with a brightness', '{"on":false,"brightness":80}'],
];

for (const [label, payload] of rejected) {
  test(`SP-15: a light command that is ${label} is refused with a warning`, () => {
    const light = gatedLight();
    const { executor, log } = executorFor(light.handler);
    executor.executeCommand('light', 'light_1', payload);
    assert.deepEqual(light.calls, []);
    assert.equal(log.lines.warn.length, 1, `expected one warning: ${JSON.stringify(log.lines)}`);
  });
}

test('SP-15: brightness on a light that is not dimmable is refused with a warning', () => {
  const light = gatedLight({ dimmable: false });
  const { executor, log } = executorFor(light.handler);
  executor.executeCommand('light', 'light_1', '{"brightness":40}');
  assert.deepEqual(light.calls, []);
  assert.ok(log.lines.warn.some((line) => line.includes('not dimmable')), log.lines.warn.join(' | '));
  assert.ok(!log.lines.info.some((line) => line.includes('Brightness requested')));
});

test('SP-15: an oversized payload is not parsed', () => {
  const light = gatedLight();
  const { executor, log } = executorFor(light.handler);
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = (...args) => { parsed += 1; return parse(...args); };
  try {
    executor.executeCommand('light', 'light_1', JSON.stringify({ on: true, pad: 'x'.repeat(5000) }));
  } finally {
    JSON.parse = parse;
  }
  assert.equal(parsed, 0);
  assert.deepEqual(light.calls, []);
  assert.ok(log.lines.warn.some((line) => line.includes('larger than')));
});

test('SP-15: identifiers from the topic are escaped and cut in log lines', () => {
  const { executor, log } = executorFor(null);
  executor.executeCommand('light', `x\nMQTT: forged line ${'y'.repeat(60000)}`, '{"on":true}');
  const output = log.all();
  assert.ok(!output.includes('\n'), 'a newline from the topic must not reach the log');
  assert.ok(output.length < 400, `log line not cut: ${output.length} chars`);
});

test('SP-15: repeated invalid commands are rate limited', () => {
  const light = gatedLight();
  const { executor, log } = executorFor(light.handler);
  for (let i = 0; i < 50; i++) executor.executeCommand('light', 'light_1', '[1]');
  assert.equal(log.lines.warn.length, 1);
});

test('M50: a scenario command with active:false does nothing', async () => {
  const calls = [];
  const handler = { device: { id: 'scenario_1', type: 'scenario', name: 'S' }, setOn: async (v) => { calls.push(v); } };
  const { executor } = executorFor(handler);
  executor.executeCommand('scenario', 'scenario_1', '{"active":false}');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
  executor.executeCommand('scenario', 'scenario_1', '{"active":true}');
  await waitFor(() => calls.length === 1);
  assert.deepEqual(calls, [true]);
});

test('a cover command reaches setTargetPosition; a cover without the method is refused', async () => {
  const positions = [];
  const cover = { device: { id: 'cover_1', type: 'cover', name: 'T' }, setTargetPosition: async (v) => { positions.push(v); } };
  const { executor } = executorFor(cover);
  executor.executeCommand('cover', 'cover_1', '{"position":30}');
  await waitFor(() => positions.length === 1);
  assert.deepEqual(positions, [30]);

  const { executor: other, log } = executorFor({ device: { id: 'zone_1', type: 'cover', name: 'Z' } });
  other.executeCommand('cover', 'zone_1', '{"position":30}');
  assert.equal(log.lines.warn.length, 1);
});

test('commands for a type without commands are refused with a warning', () => {
  const { executor, log } = executorFor({ device: { id: 'zone_1', type: 'zone' } });
  executor.executeCommand('zone', 'zone_1', '{"open":true}');
  assert.ok(log.lines.warn.some((line) => line.includes('Unsupported device type')));
});

function failingLight(error) {
  return { device: { id: 'light_1', type: 'light', name: 'L', status: {} }, setOn: async () => { throw error; } };
}

test('a command refused by the panel queue or by validation is a readable warning, not an error', async () => {
  const queueRefusal = Object.assign(new Error('Command for light_1 not sent'), { name: 'CommandQueueRejectedError', reason: 'superseded' });
  const unknownDevice = new ValidationKlaresError('Command refused: 1 is not a light discovered on the panel');
  const routing = new ThermostatRoutingError('Thermostat cfg 7 could not be read from the panel before the write; write refused');
  for (const [error, text] of [[queueRefusal, 'newer command'], [unknownDevice, 'not a light discovered'], [routing, 'write refused']]) {
    const { executor, log } = executorFor(failingLight(error));
    executor.executeCommand('light', 'light_1', '{"on":true}');
    await waitFor(() => log.lines.warn.length === 1);
    assert.deepEqual(log.lines.error, []);
    assert.ok(log.lines.warn[0].includes(text), log.lines.warn[0]);
  }
});

test('an unexpected failure is still logged as an error', async () => {
  const { executor, log } = executorFor(failingLight(new Error('boom')));
  executor.executeCommand('light', 'light_1', '{"on":true}');
  await waitFor(() => log.lines.error.length === 1);
  assert.ok(log.lines.error[0].includes('boom'));
});
