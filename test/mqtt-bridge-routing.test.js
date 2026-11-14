'use strict';

// Where state goes and which device a command reaches: room level of the
// command topic (SP-06), excluded devices (SP-09), name collisions and empty
// slugs (SP-10), retransmissions and oversized payloads at the intake.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MqttBridge } = require('../dist/mqtt-bridge/index.js');
const { fakeMqtt, recordingLog } = require('./fixtures/fake-mqtt.js');
const { waitFor } = require('./fixtures/wait-for.js');

function light(id, name, calls) {
  return {
    device: { id, type: 'light', name, description: name, status: { on: false, dimmable: false } },
    setOn: async (value) => { calls.push(`${id}:${value}`); },
  };
}

function setup({ handlers = [], roomMapping, mqttConfig = {}, isDeviceExcluded, config = {} } = {}) {
  const log = recordingLog();
  const mqtt = fakeMqtt();
  const platform = {
    accessoryHandlers: new Map(handlers.map((handler, i) => [`uuid-${i}`, handler])),
    config: { ...config, ...(roomMapping ? { roomMapping } : {}) },
  };
  const bridge = new MqttBridge(
    { enabled: true, broker: 'mqtt://broker.example', ...mqttConfig },
    log.logger,
    platform,
    { connect: mqtt.connect, ...(isDeviceExcluded ? { isDeviceExcluded } : {}) },
  );
  mqtt.client.simulateConnect();
  return { bridge, log, client: mqtt.client };
}

const rooms = {
  enabled: true,
  rooms: [
    { roomName: 'studio', devices: [{ deviceId: 'light_2' }] },
    { roomName: 'cucina', devices: [{ deviceId: 'light_3' }] },
  ],
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('SP-06: with roomMapping a command on another room\'s topic is refused (by ID and by slug)', async () => {
  const calls = [];
  const { client, log } = setup({ handlers: [light('light_2', 'Luce Studio', calls)], roomMapping: rooms });
  client.deliver('homebridge/klares4/cucina/light/light_2/set', '{"on":true}');
  client.deliver('homebridge/klares4/qualunque/light/luce_studio/set', '{"on":false}');
  await settle();
  assert.deepEqual(calls, []);
  assert.ok(log.lines.warn.some((line) => line.includes('not in room')), log.lines.warn.join(' | '));
});

test('SP-06: the right room, or the direct topic, still reaches the device', async () => {
  const calls = [];
  const { client } = setup({ handlers: [light('light_2', 'Luce Studio', calls)], roomMapping: rooms });
  client.deliver('homebridge/klares4/studio/light/light_2/set', '{"on":true}');
  await waitFor(() => calls.length === 1);
  client.deliver('homebridge/klares4/light/luce_studio/set', '{"on":false}');
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls, ['light_2:true', 'light_2:false']);
});

test('SP-06: the room tells apart two devices with the same name', async () => {
  const calls = [];
  const { client } = setup({
    handlers: [light('light_2', 'Luce', calls), light('light_3', 'Luce', calls)],
    roomMapping: rooms,
  });
  client.deliver('homebridge/klares4/cucina/light/luce/set', '{"on":true}');
  await waitFor(() => calls.length === 1);
  assert.deepEqual(calls, ['light_3:true']);
});

test('SP-06: without roomMapping the room level is not checked (unchanged)', async () => {
  const calls = [];
  const { client } = setup({ handlers: [light('light_2', 'Luce Studio', calls)] });
  client.deliver('homebridge/klares4/qualunque/light/light_2/set', '{"on":true}');
  await waitFor(() => calls.length === 1);
});

test('SP-09: an excluded device restored from the cache is not commandable', async () => {
  const calls = [];
  const { client } = setup({
    handlers: [light('light_2', 'Luce Due', calls), light('light_4', 'Luce Quattro', calls)],
    isDeviceExcluded: (device) => device.id === 'light_2',
  });
  client.deliver('homebridge/klares4/light/light_2/set', '{"on":true}');
  client.deliver('homebridge/klares4/light/luce_due/set', '{"on":true}');
  client.deliver('homebridge/klares4/light/light_4/set', '{"on":true}');
  await waitFor(() => calls.length === 1);
  await settle();
  assert.deepEqual(calls, ['light_4:true']);
});

/** Topic → device ID of the retained state a broker would hold after these publishes. */
function retained(client) {
  const live = new Map();
  for (const entry of client.published.filter((e) => e.topic.endsWith('/state'))) {
    if (entry.payload === '') live.delete(entry.topic);
    else live.set(entry.topic, JSON.parse(entry.payload).id);
  }
  return Object.fromEntries([...live].sort());
}

const state = (id, name) => ({ id, type: 'light', name, description: name, status: { on: true } });

test('SP-10: three lights with the same name get one topic each, one warning', () => {
  const { bridge, client, log } = setup();
  bridge.publishDeviceState(state('light_1', 'Luce Bagno'));
  bridge.publishDeviceState(state('light_6', 'Luce  Bagno'));
  bridge.publishDeviceState(state('light_8', 'luce bagno'));
  bridge.publishDeviceState(state('light_5', 'Luce Sala'));
  bridge.publishDeviceState(state('light_8', 'luce bagno'));
  assert.deepEqual(retained(client), {
    'homebridge/klares4/light/light_1/state': 'light_1',
    'homebridge/klares4/light/light_6/state': 'light_6',
    'homebridge/klares4/light/light_8/state': 'light_8',
    'homebridge/klares4/light/luce_sala/state': 'light_5',
  });
  const collisionWarnings = log.lines.warn.filter((line) => line.includes('same state topic'));
  assert.ok(collisionWarnings.length <= 2, collisionWarnings.join(' | '));
  assert.ok(collisionWarnings.at(-1).includes('light_1, light_6, light_8'));
});

test('SP-10: the topics do not depend on the order devices are published in', () => {
  const a = setup();
  a.bridge.publishDeviceState(state('light_1', 'Luce'));
  a.bridge.publishDeviceState(state('light_2', 'Luce'));
  const b = setup();
  b.bridge.publishDeviceState(state('light_2', 'Luce'));
  b.bridge.publishDeviceState(state('light_1', 'Luce'));
  assert.deepEqual(retained(a.client), retained(b.client));
});

test('SP-10: a name without letters or digits publishes under the device ID', () => {
  const { bridge, client, log } = setup();
  bridge.publishDeviceState(state('light_9', '***'));
  bridge.publishDeviceState(state('light_10', '---'));
  assert.deepEqual(retained(client), {
    'homebridge/klares4/light/light_10/state': 'light_10',
    'homebridge/klares4/light/light_9/state': 'light_9',
  });
  assert.ok(!client.published.some((entry) => entry.topic.includes('//')));
  assert.ok(log.lines.warn.length >= 1);
});

test('SP-10: a device named like another device\'s ID does not lose its topic', () => {
  const { bridge, client } = setup();
  bridge.publishDeviceState(state('light_3', 'light 1'));
  bridge.publishDeviceState(state('light_1', 'Doppia'));
  bridge.publishDeviceState(state('light_2', 'Doppia'));
  assert.deepEqual(retained(client), {
    'homebridge/klares4/light/light_1/state': 'light_3',
    'homebridge/klares4/light/light_1_2/state': 'light_1',
    'homebridge/klares4/light/light_2/state': 'light_2',
  }, 'the name-based topic is kept; the ID fallback is numbered');
});

test('SP-10: devices that do not collide keep their topic (with and without rooms)', () => {
  const { bridge, client } = setup({ roomMapping: rooms });
  bridge.publishDeviceState(state('light_2', 'Luce'));
  bridge.publishDeviceState(state('light_3', 'Luce'));
  bridge.publishDeviceState(state('light_7', 'Luce'));
  assert.deepEqual(retained(client), {
    'homebridge/klares4/cucina/light/luce/state': 'light_3',
    'homebridge/klares4/light/luce/state': 'light_7',
    'homebridge/klares4/studio/light/luce/state': 'light_2',
  });
});

test('a QoS 1 retransmission (DUP, same packet ID) is not executed twice', async () => {
  const calls = [];
  const { client } = setup({ handlers: [light('light_1', 'Luce', calls)] });
  client.deliver('homebridge/klares4/light/light_1/set', '{"on":true}', { qos: 1, messageId: 11 });
  await waitFor(() => calls.length === 1);
  client.deliver('homebridge/klares4/light/light_1/set', '{"on":true}', { qos: 1, messageId: 11, dup: true });
  client.deliver('homebridge/klares4/light/light_1/set', '{"on":false}', { qos: 1, messageId: 11 });
  await waitFor(() => calls.length === 2);
  await settle();
  assert.deepEqual(calls, ['light_1:true', 'light_1:false']);
});

test('SP-15: an oversized payload is dropped before it is converted to text', () => {
  const calls = [];
  const { client, log } = setup({ handlers: [light('light_1', 'Luce', calls)] });
  const huge = Buffer.alloc(40 * 1024 * 1024, 0x20);
  const toString = Buffer.prototype.toString;
  let converted = 0;
  Buffer.prototype.toString = function (...args) { if (this === huge) converted += 1; return toString.apply(this, args); };
  try {
    client.emit('message', 'homebridge/klares4/light/light_1/set', huge, { cmd: 'publish', retain: false, qos: 0 });
  } finally {
    Buffer.prototype.toString = toString;
  }
  assert.equal(converted, 0);
  assert.deepEqual(calls, []);
  assert.ok(log.lines.warn.some((line) => line.includes('larger than')));
});

test('SP-15: a topic with a newline is logged escaped', () => {
  const { client, log } = setup();
  client.deliver('homebridge/klares4/light/a\nMQTT: forged/x/y/set', '{"on":true}');
  assert.ok(!log.all().includes('\nMQTT: forged'));
});
