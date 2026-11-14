'use strict';

// MqttBridge with an injected client: availability topic and last will
// (SP-11), state-only mode (SP-04), reconnection and log volume (SP-07,
// TD-DOC-02), broker URL handling (SP-14).

const test = require('node:test');
const assert = require('node:assert/strict');

const { MqttBridge } = require('../dist/mqtt-bridge/index.js');
const { fakeMqtt, recordingLog } = require('./fixtures/fake-mqtt.js');
const { waitFor } = require('./fixtures/wait-for.js');

function setup(mqttConfig = {}, { backoff = { initialMs: 5, maxMs: 20 }, handlers = new Map() } = {}) {
  const log = recordingLog();
  const mqtt = fakeMqtt();
  const bridge = new MqttBridge(
    { enabled: true, broker: 'mqtt://broker.example', ...mqttConfig },
    log.logger,
    { accessoryHandlers: handlers, config: {} },
    { connect: mqtt.connect, reconnectBackoff: backoff },
  );
  return { bridge, log, mqtt, client: mqtt.client };
}

const statusMessages = (client) => client.published
  .filter((entry) => entry.topic === 'homebridge/klares4/status')
  .map((entry) => ({ ...JSON.parse(entry.payload), retain: entry.options.retain }));

test('SP-11: the CONNECT carries a retained last will "offline" on <prefix>/status', () => {
  const { client } = setup({ qos: 0 });
  const will = client.options.will;
  assert.equal(will.topic, 'homebridge/klares4/status');
  assert.deepEqual(JSON.parse(String(will.payload)), { state: 'offline' });
  assert.equal(will.retain, true);
  assert.equal(will.qos, 0);
  assert.equal(client.options.clean, true, 'a clean session never replays queued commands');
});

test('SP-11: online on connect, panel state on change, offline on shutdown', () => {
  const { bridge, client } = setup({ topicPrefix: 'casa/allarme' });
  assert.equal(client.options.will.topic, 'casa/allarme/status');
  client.simulateConnect();
  bridge.setPanelConnected(true);
  bridge.setPanelConnected(true);
  bridge.setPanelConnected(false);
  bridge.disconnect();
  const status = client.published
    .filter((entry) => entry.topic === 'casa/allarme/status')
    .map((entry) => { const p = JSON.parse(entry.payload); return `${p.state}/${p.panel ?? '-'}/${entry.options.retain}`; });
  assert.deepEqual(status, ['online/unknown/true', 'online/connected/true', 'online/disconnected/true', 'offline/-/true']);
  assert.equal(client.ended, true);
});

test('SP-11: the panel state known before the broker connects is published on connect', () => {
  const { bridge, client } = setup();
  bridge.setPanelConnected(true);
  assert.equal(client.published.length, 0);
  client.simulateConnect();
  const [online] = statusMessages(client);
  assert.equal(online.state, 'online');
  assert.equal(online.panel, 'connected');
  assert.ok(!Number.isNaN(Date.parse(online.timestamp)));
});

test('SP-04: with commands:false nothing is subscribed and state is still published', () => {
  const calls = [];
  const handlers = new Map([['u1', { device: { id: 'light_1', type: 'light', name: 'Luce' }, setOn: async (v) => calls.push(v) }]]);
  const { bridge, client, log } = setup({ commands: false }, { handlers });
  client.simulateConnect();
  bridge.publishDeviceState({ id: 'light_1', type: 'light', name: 'Luce', status: { on: true } });
  client.deliver('homebridge/klares4/light/light_1/set', '{"on":true}');
  assert.deepEqual(client.subscriptions, []);
  assert.ok(client.published.some((entry) => entry.topic === 'homebridge/klares4/light/luce/state'));
  assert.deepEqual(calls, []);
  assert.ok(log.lines.info.some((line) => line.includes('Commands disabled')));
});

test('SP-04: commands stay on by default', () => {
  const { client } = setup();
  client.simulateConnect();
  assert.deepEqual(client.subscriptions[0].topics, ['homebridge/klares4/+/+/set', 'homebridge/klares4/+/+/+/set']);
});

test('SP-07: mqtt.js never reconnects by itself; the bridge does, also after a refused CONNACK', async () => {
  const { client } = setup();
  assert.equal(client.options.reconnectPeriod, 0);
  client.simulateConnackRefused(5);
  await waitFor(() => client.reconnects === 1);
  client.simulateConnackRefused(5);
  await waitFor(() => client.reconnects === 2);
  client.simulateConnect();
  assert.equal(client.connected, true);
});

test('SP-07: the retry delay doubles up to the maximum and resets after a connection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client } = setup({}, { backoff: { initialMs: 1000, maxMs: 4000 } });
  const fireAfter = (ms) => {
    const before = client.reconnects;
    t.mock.timers.tick(ms - 1);
    assert.equal(client.reconnects, before, `fired before ${ms} ms`);
    t.mock.timers.tick(1);
    assert.equal(client.reconnects, before + 1, `did not fire at ${ms} ms`);
  };
  for (const delay of [1000, 2000, 4000, 4000]) {
    client.simulateClose(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    fireAfter(delay);
  }
  client.simulateConnect();
  client.simulateClose();
  fireAfter(1000);
});

test('TD-DOC-02: a broker down for many attempts logs on transitions only', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, log } = setup({}, { backoff: { initialMs: 1000, maxMs: 4000 } });
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
  for (let i = 0; i < 100; i++) {
    client.simulateClose(refused());
    t.mock.timers.tick(4000);
  }
  assert.equal(log.lines.error.length, 1, log.lines.error.join(' | '));
  assert.equal(log.lines.warn.length, 1, log.lines.warn.join(' | '));
  assert.equal(log.lines.info.length, 0, log.lines.info.join(' | '));

  client.simulateConnect();
  assert.ok(log.lines.info.some((line) => line.includes('Reconnected')));
  client.simulateClose(refused());
  assert.equal(log.lines.warn.filter((line) => line.includes('lost')).length, 1);
  assert.equal(log.lines.error.length, 2, 'the same error after a new failure period is logged again');
});

test('SP-11: a CONNECT refused with its last will is retried without, and the ACL hint is logged once', async () => {
  const { client, log } = setup();
  client.simulateConnackRefused(5);
  await waitFor(() => client.reconnects === 1);
  assert.equal(client.connectWills[1], undefined, 'second attempt without the will');
  client.simulateConnect();
  assert.equal(log.lines.warn.filter((line) => line.includes('ACL')).length, 1);
});

test('SP-11: wrong credentials (refused with and without the will) keep the will for later attempts', async () => {
  const { client } = setup();
  client.simulateConnackRefused(5);
  await waitFor(() => client.reconnects === 1);
  client.simulateConnackRefused(5);
  await waitFor(() => client.reconnects === 2);
  assert.ok(client.connectWills[2], 'the will is back once the credentials are shown to be the cause');
});

test('shutdown stops the reconnection loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { bridge, client } = setup({}, { backoff: { initialMs: 1000, maxMs: 1000 } });
  client.simulateClose();
  bridge.disconnect();
  t.mock.timers.tick(5000);
  assert.equal(client.reconnects, 0);
  assert.equal(client.endForced, true, 'not connected: nothing to flush');
});

const refusedUrls = [
  ['without a scheme', 'broker.example:1883'],
  ['user:password@host without a scheme', 'mario:Sup3rSecret@broker.example'],
  ['with one slash (mqtt.js would use localhost:1883)', 'mqtt:/mario:Sup3rSecret@broker.example'],
  ['with an unsupported scheme', 'http://mario:Sup3rSecret@broker.example'],
  ['with an unescaped / in the password', 'mqtt://mario:Sup3r/Secret@broker.example'],
  ['with a port out of range', 'mqtt://broker.example:99999'],
  ['made of spaces', '   '],
];

for (const [label, broker] of refusedUrls) {
  test(`SP-14/SP-23: a broker URL ${label} is refused before any connection, without echoing it`, () => {
    const { mqtt, log } = setup({ broker });
    assert.equal(mqtt.calls.length, 0);
    assert.equal(log.lines.error.length, 1);
    assert.ok(!/Sup3r|mario|broker\.example/.test(log.all()), log.all());
  });
}

test('SP-14: a leading space is trimmed and credentials never reach the log', () => {
  const { mqtt, log, client } = setup({ broker: '  mqtt://mario:Sup3rSecret@broker.example:1884 ' });
  assert.equal(mqtt.calls[0].url, 'mqtt://mario:Sup3rSecret@broker.example:1884');
  client.simulateConnect();
  assert.ok(log.all().includes('mqtt://broker.example:1884'));
  assert.ok(!/Sup3r|mario/.test(log.all()), log.all());
});

test('SP-23: a topicPrefix with a wildcard is refused before connecting', () => {
  const { mqtt, log } = setup({ topicPrefix: 'casa/#' });
  assert.equal(mqtt.calls.length, 0);
  assert.ok(log.lines.error.some((line) => line.includes('topicPrefix')));
});
