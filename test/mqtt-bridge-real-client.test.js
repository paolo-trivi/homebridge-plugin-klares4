'use strict';

// The real mqtt.js client against a throw-away broker on 127.0.0.1 with an
// ephemeral port (never the 1883 of a broker that may run on this host):
// a refused CONNACK is retried (SP-07), the CONNECT carries the last will
// and the status topic goes online, then offline at shutdown (SP-11).

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const mqttPacket = require('mqtt-packet');

const { MqttBridge } = require('../dist/mqtt-bridge/index.js');
const { recordingLog } = require('./fixtures/fake-mqtt.js');
const { waitFor } = require('./fixtures/wait-for.js');

async function fakeBroker(t, connackCodes) {
  const packets = [];
  const sockets = new Set();
  let connects = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const parser = mqttPacket.parser({ protocolVersion: 4 });
    const send = (packet) => socket.writable && socket.write(mqttPacket.generate(packet));
    parser.on('packet', (packet) => {
      packets.push(packet);
      if (packet.cmd === 'connect') {
        const returnCode = connackCodes[Math.min(connects, connackCodes.length - 1)];
        connects += 1;
        send({ cmd: 'connack', returnCode, sessionPresent: false });
        if (returnCode !== 0) socket.end();
      }
      if (packet.cmd === 'subscribe') send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map((s) => s.qos) });
      if (packet.cmd === 'publish' && packet.qos === 1) send({ cmd: 'puback', messageId: packet.messageId });
      if (packet.cmd === 'disconnect') socket.end();
    });
    socket.on('data', (data) => parser.parse(data));
    socket.on('error', () => undefined);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.notEqual(port, 1883);
  t.after(() => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(resolve); }));
  return { port, packets, connects: () => connects };
}

test('real mqtt.js: wrong credentials, then right ones: the bridge reconnects by itself', async (t) => {
  const broker = await fakeBroker(t, [5, 5, 0]);
  const log = recordingLog();
  const bridge = new MqttBridge(
    { enabled: true, broker: `mqtt://127.0.0.1:${broker.port}`, username: 'u', password: 'p' },
    log.logger,
    { accessoryHandlers: new Map(), config: {} },
    { reconnectBackoff: { initialMs: 10, maxMs: 40 } },
  );
  t.after(() => bridge.disconnect());
  await waitFor(() => log.lines.info.some((line) => line.includes('Reconnected to broker')));
  assert.equal(broker.connects(), 3);
  assert.equal(log.lines.error.length, 1, `the repeated refusal is logged once: ${log.lines.error.join(' | ')}`);

  const connects = broker.packets.filter((p) => p.cmd === 'connect');
  assert.equal(connects[0].will.topic, 'homebridge/klares4/status');
  assert.equal(connects[0].will.retain, true);
  assert.equal(connects[1].will, undefined, 'the attempt after a refusal goes without the will');
  assert.ok(connects[2].will, 'refused without the will too: the will comes back');
  assert.equal(connects[2].clean, true);
});

test('real mqtt.js: online on connect, offline and DISCONNECT at shutdown', async (t) => {
  const broker = await fakeBroker(t, [0]);
  const log = recordingLog();
  const bridge = new MqttBridge(
    { enabled: true, broker: `mqtt://127.0.0.1:${broker.port}` },
    log.logger,
    { accessoryHandlers: new Map(), config: {} },
  );
  const statuses = () => broker.packets
    .filter((p) => p.cmd === 'publish' && p.topic === 'homebridge/klares4/status')
    .map((p) => `${JSON.parse(p.payload.toString()).state}:${p.retain}`);
  await waitFor(() => statuses().length === 1);
  bridge.publishDeviceState({ id: 'light_1', type: 'light', name: 'Luce', status: { on: true } });
  bridge.disconnect();
  await waitFor(() => broker.packets.some((p) => p.cmd === 'disconnect'));
  assert.deepEqual(statuses(), ['online:true', 'offline:true']);
  assert.ok(broker.packets.some((p) => p.cmd === 'publish' && p.topic === 'homebridge/klares4/light/luce/state'));
});
