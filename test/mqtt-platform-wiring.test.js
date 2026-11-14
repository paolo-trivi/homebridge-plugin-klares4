'use strict';

// The real platform with MQTT on, against the mock panel and a throw-away
// broker (both on 127.0.0.1, ephemeral ports): the panel connection on
// `<prefix>/status` (SP-11) and the platform's exclusion decision applied to
// MQTT commands (SP-09).

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { startMockPanel } = require('./fixtures/lares4-mock-panel.js');
const { createPlatform } = require('./fixtures/platform-session-harness.js');
const { startFakeBroker } = require('./fixtures/fake-mqtt-broker.js');
const { waitFor } = require('./fixtures/wait-for.js');

const STATUS = 'homebridge/klares4/status';
const synced = (log) => log.lines.some((line) => line.includes('Initial synchronization completed'));
const panels = (broker) => broker.published(STATUS).filter((s) => s.state === 'online').map((s) => s.panel);

async function panelFor(t, options) {
  const panel = await startMockPanel(options);
  t.after(() => panel.close());
  return panel;
}

/** A loopback port with nothing listening: the panel is off. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('SP-11: a connected panel is published as panel:connected', async (t) => {
  const broker = await startFakeBroker(t);
  const panel = await panelFor(t);
  const { api, log } = createPlatform(t, { port: panel.port, config: { mqtt: { enabled: true, broker: broker.url } } });
  api.emit('didFinishLaunching');
  await waitFor(() => synced(log) && panels(broker).at(-1) === 'connected');
  assert.ok(!panels(broker).includes('unknown'), JSON.stringify(panels(broker)));
});

test('SP-11: a panel offline from boot is published as disconnected, not unknown', async (t) => {
  const broker = await startFakeBroker(t);
  const { api, log } = createPlatform(t, { port: await closedPort(), config: { mqtt: { enabled: true, broker: broker.url } } });
  api.emit('didFinishLaunching');
  await waitFor(() => panels(broker).length > 0);
  await waitFor(() => log.lines.some((line) => /initialization error|ECONNREFUSED/i.test(line)));
  assert.deepEqual([...new Set(panels(broker))], ['disconnected']);
});

test('SP-11: a panel reconnection goes disconnected, then connected again', async (t) => {
  const broker = await startFakeBroker(t);
  const panel = await panelFor(t);
  const { api, log } = createPlatform(t, { port: panel.port, config: { mqtt: { enabled: true, broker: broker.url } } });
  api.emit('didFinishLaunching');
  await waitFor(() => synced(log) && panels(broker).at(-1) === 'connected');
  const before = panels(broker).length;
  panel.dropConnections();
  await waitFor(() => panels(broker).slice(before).join(',') === 'disconnected,connected');
});

test('SP-09: the bridge uses the platform\'s exclusion decision, also for a stale cached handler', async (t) => {
  const broker = await startFakeBroker(t);
  const panel = await panelFor(t);
  const { platform, api, log } = createPlatform(t, {
    port: panel.port,
    config: { excludeOutputs: ['5'], mqtt: { enabled: true, broker: broker.url } },
  });
  api.emit('didFinishLaunching');
  await waitFor(() => synced(log) && broker.subscribed());
  const light6 = [...platform.accessoryHandlers.values()].find((h) => h.device?.id === 'light_6');
  assert.ok(light6, 'light_6 has a handler');
  // A handler left for the excluded light, as a cache restored by an older version would.
  const stale = Object.create(Object.getPrototypeOf(light6));
  Object.assign(stale, light6, { device: { ...light6.device, id: 'light_5', name: 'Light A' } });
  platform.accessoryHandlers.set('stale-light-5', stale);

  const commands = () => panel.received.filter((m) => m.CMD === 'CMD_USR');
  broker.publish('homebridge/klares4/light/light_5/set', '{"on":true}');
  broker.publish('homebridge/klares4/light/light_6/set', '{"on":true}');
  await waitFor(() => commands().length === 1);
  const ids = commands().map((m) => JSON.stringify(m.PAYLOAD));
  assert.equal(ids.length, 1, ids.join(' | '));
  assert.match(ids[0], /"6"/);
});
