const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { fakeMqtt, recordingLog } = require('./fixtures/fake-mqtt.js');

// The MQTT client is injected: no broker is ever contacted (TD-T-12).
const { MqttBridge } = require('../dist/mqtt-bridge/index.js');

function createPlatform({ handlers = new Map(), roomMapping } = {}) {
  return { accessoryHandlers: handlers, config: roomMapping ? { roomMapping } : {} };
}

function createBridge(mqttConfig, platformOptions) {
  const log = recordingLog();
  const mqtt = fakeMqtt();
  const bridge = new MqttBridge({ enabled: true, ...mqttConfig }, log.logger, createPlatform(platformOptions), { connect: mqtt.connect });
  const call = mqtt.calls[mqtt.calls.length - 1];
  return { bridge, log, call, client: call ? call.client : undefined };
}

test('MqttBridge keeps the port from an mqtts:// broker URL when no port is configured', () => {
  const { call } = createBridge({ broker: 'mqtts://broker.example:8883' });
  assert.equal(call.url, 'mqtts://broker.example:8883');
  assert.equal('port' in call.options, false, `port must not override the URL: ${JSON.stringify(call.options)}`);
});

test('MqttBridge keeps the port of a ws:// broker URL without an explicit port', () => {
  const { call } = createBridge({ broker: 'ws://broker.example/mqtt' });
  assert.equal(call.options.port, undefined);
});

test('MqttBridge still honours an explicitly configured port', () => {
  const { call } = createBridge({ broker: 'mqtt://broker.example', port: 1884 });
  assert.equal(call.options.port, 1884);
});

test('MqttBridge sends a configured username even without a password', () => {
  const { call } = createBridge({ broker: 'mqtt://broker.example', username: 'homebridge' });
  assert.equal(call.options.username, 'homebridge');
  assert.equal('password' in call.options, false);
});

test('MqttBridge sends username and password when both are configured', () => {
  const { call } = createBridge({ broker: 'mqtt://broker.example', username: 'u', password: 'p' });
  assert.equal(call.options.username, 'u');
  assert.equal(call.options.password, 'p');
});

test('MqttBridge never logs credentials embedded in the broker URL', () => {
  const { client, log } = createBridge({ broker: 'mqtt://mqttuser:s3cr3t-pass@broker.example:1883' });
  client.simulateConnect();
  const output = log.all();
  assert.ok(!output.includes('s3cr3t-pass'), `password leaked in logs: ${output}`);
  assert.ok(!output.includes('mqttuser'), `username leaked in logs: ${output}`);
  assert.ok(output.includes('mqtt://broker.example:1883'), `broker host missing: ${output}`);
});

function createScenarioHandler(calls) {
  return {
    device: { id: 'scenario_1', type: 'scenario', name: 'Buonanotte', status: { active: false } },
    setOn: async (value) => { calls.push(value); },
  };
}

test('MqttBridge ignores retained command messages and warns', () => {
  const calls = [];
  const handlers = new Map([['uuid-s1', createScenarioHandler(calls)]]);
  const { client, log } = createBridge({ broker: 'mqtt://broker.example' }, { handlers });
  client.simulateConnect();

  client.emit(
    'message',
    'homebridge/klares4/scenario/scenario_1/set',
    Buffer.from('{"active":true}'),
    { cmd: 'publish', retain: true, topic: 'homebridge/klares4/scenario/scenario_1/set' },
  );

  assert.deepEqual(calls, [], 'a retained command must not be executed');
  assert.ok(
    log.lines.warn.some((line) => line.includes('retained') && line.includes('scenario/scenario_1/set')),
    `missing retained warning: ${log.lines.warn.join(' | ')}`,
  );
});

test('MqttBridge still executes live (non-retained) command messages', () => {
  const calls = [];
  const handlers = new Map([['uuid-s1', createScenarioHandler(calls)]]);
  const { client } = createBridge({ broker: 'mqtt://broker.example' }, { handlers });
  client.simulateConnect();

  client.emit(
    'message',
    'homebridge/klares4/scenario/scenario_1/set',
    Buffer.from('{"active":true}'),
    { cmd: 'publish', retain: false, topic: 'homebridge/klares4/scenario/scenario_1/set' },
  );

  assert.deepEqual(calls, [true]);
});

function createLight(id, name) {
  return { id, type: 'light', name, description: name, status: { on: true, dimmable: false } };
}

function withStatus(device, status) {
  return { ...device, status: { ...device.status, ...status } };
}

function statePublishes(client) {
  return client.published.filter((entry) => entry.payload !== '' && entry.topic.endsWith('/state'));
}

test('MqttBridge does not queue state publishes while the broker is disconnected', () => {
  const { bridge, client } = createBridge({ broker: 'mqtt://broker.example' });
  bridge.publishDeviceState(createLight('light_1', 'Luce Sala'));
  bridge.publishDeviceState(withStatus(createLight('light_1', 'Luce Sala'), { on: false }));
  assert.equal(client.published.length, 0, 'nothing may be handed to mqtt.js while offline');
});

test('MqttBridge republishes the latest state snapshot on connect', () => {
  const { bridge, client } = createBridge({ broker: 'mqtt://broker.example' });
  bridge.publishDeviceState(createLight('light_1', 'Luce Sala'));
  bridge.publishDeviceState(withStatus(createLight('light_1', 'Luce Sala'), { on: false }));
  bridge.publishDeviceState(createLight('light_2', 'Luce Cucina'));

  client.simulateConnect();

  const published = statePublishes(client);
  assert.deepEqual(
    published.map((entry) => entry.topic).sort(),
    ['homebridge/klares4/light/luce_cucina/state', 'homebridge/klares4/light/luce_sala/state'],
  );
  const sala = published.find((entry) => entry.topic.endsWith('/luce_sala/state'));
  assert.equal(JSON.parse(sala.payload).on, false, 'the snapshot must carry the latest state');
  assert.equal(sala.options.retain, true);
});

test('MqttBridge publishes immediately while connected and replays after a reconnect', () => {
  const { bridge, client } = createBridge({ broker: 'mqtt://broker.example' });
  client.simulateConnect();
  bridge.publishDeviceState(createLight('light_1', 'Luce Sala'));
  assert.equal(statePublishes(client).length, 1);

  client.simulateClose();
  bridge.publishDeviceState(withStatus(createLight('light_1', 'Luce Sala'), { on: false }));
  assert.equal(statePublishes(client).length, 1, 'no publish while offline');

  client.simulateConnect();
  const published = statePublishes(client);
  assert.equal(published.length, 2);
  assert.equal(JSON.parse(published[1].payload).on, false);
});

test('MqttBridge clears the old retained state topic when a device is renamed', () => {
  const { bridge, client } = createBridge({ broker: 'mqtt://broker.example' });
  client.simulateConnect();
  bridge.publishDeviceState(createLight('light_1', 'Luce Sala'));
  bridge.publishDeviceState(createLight('light_1', 'Luce Salotto'));

  const clear = client.published.find(
    (entry) => entry.topic === 'homebridge/klares4/light/luce_sala/state' && entry.payload === '',
  );
  assert.ok(clear, `old topic not cleared: ${JSON.stringify(client.published)}`);
  assert.equal(clear.options.retain, true);
  assert.equal(client.published.at(-1).topic, 'homebridge/klares4/light/luce_salotto/state');
});

test('MqttBridge clears the old topic when a device is renamed while offline', () => {
  const { bridge, client } = createBridge({ broker: 'mqtt://broker.example' });
  client.simulateConnect();
  bridge.publishDeviceState(createLight('light_1', 'Luce Sala'));
  client.simulateClose();
  bridge.publishDeviceState(createLight('light_1', 'Luce Salotto'));
  client.simulateConnect();

  const topics = client.published
    .filter((entry) => entry.topic.endsWith('/state'))
    .map((entry) => `${entry.topic}|${entry.payload === '' ? 'clear' : 'state'}`);
  assert.deepEqual(topics, [
    'homebridge/klares4/light/luce_sala/state|state',
    'homebridge/klares4/light/luce_sala/state|clear',
    'homebridge/klares4/light/luce_salotto/state|state',
  ]);
});

test('MqttBridge gives two devices with the same name topic their own ID topics (SP-10)', () => {
  const { bridge, client } = createBridge({ broker: 'mqtt://broker.example' });
  client.simulateConnect();
  bridge.publishDeviceState(createLight('light_1', 'Luce Sala'));
  bridge.publishDeviceState(createLight('light_2', 'Luce_Sala'));
  const live = new Map();
  for (const entry of client.published.filter((e) => e.topic.endsWith('/state'))) {
    if (entry.payload === '') live.delete(entry.topic);
    else live.set(entry.topic, JSON.parse(entry.payload).id);
  }
  assert.deepEqual([...live].sort(), [
    ['homebridge/klares4/light/light_1/state', 'light_1'],
    ['homebridge/klares4/light/light_2/state', 'light_2'],
  ]);
});

test('MqttBridge does not clear anything when retain is disabled or the topic is unchanged', () => {
  const { bridge, client } = createBridge({ broker: 'mqtt://broker.example', retain: false });
  client.simulateConnect();
  bridge.publishDeviceState(createLight('light_1', 'Luce Sala'));
  bridge.publishDeviceState(createLight('light_1', 'Luce Sala'));
  bridge.publishDeviceState(createLight('light_1', 'Luce Salotto'));
  assert.equal(client.published.filter((entry) => entry.payload === '').length, 0);
});

function roomMappingFor(roomName, deviceId) {
  return { enabled: true, rooms: [{ roomName, devices: [{ deviceId }] }] };
}

test('MqttBridge keeps the topic of a valid room name unchanged', () => {
  const { bridge, client, log } = createBridge(
    { broker: 'mqtt://broker.example' },
    { roomMapping: roomMappingFor('Sala Grande', 'light_1') },
  );
  client.simulateConnect();
  bridge.publishDeviceState(createLight('light_1', 'Luce Sala'));
  assert.equal(client.published.at(-1).topic, 'homebridge/klares4/Sala Grande/light/luce_sala/state');
  assert.equal(log.lines.warn.length, 0);
});

test('MqttBridge never publishes a room name containing MQTT wildcards or level separators', () => {
  const { bridge, client, log } = createBridge(
    { broker: 'mqtt://broker.example' },
    { roomMapping: roomMappingFor('Sala+Cucina/#1', 'light_1') },
  );
  client.simulateConnect();
  bridge.publishDeviceState(createLight('light_1', 'Luce Sala'));
  bridge.publishDeviceState(createLight('light_1', 'Luce Sala'));

  const topics = client.published.map((entry) => entry.topic);
  for (const topic of topics) {
    assert.ok(!/[+#]/.test(topic), `wildcard in publish topic: ${topic}`);
  }
  assert.equal(topics.at(-1), 'homebridge/klares4/Sala_Cucina__1/light/luce_sala/state');
  const roomWarnings = log.lines.warn.filter((line) => line.includes('Sala+Cucina/#1'));
  assert.equal(roomWarnings.length, 1, `expected exactly one warning per room: ${log.lines.warn.join(' | ')}`);
});
