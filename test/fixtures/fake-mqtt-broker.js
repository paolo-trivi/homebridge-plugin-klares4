'use strict';

// Throw-away MQTT 3.1.1 broker on 127.0.0.1 with an ephemeral port (never
// 1883, where a real broker may listen on the host). It records every packet
// and can push a publish to the connected clients. Closed by `t.after`.

const assert = require('node:assert/strict');
const net = require('node:net');
const mqttPacket = require('mqtt-packet');

async function startFakeBroker(t, { connackCodes = [0] } = {}) {
  const packets = [];
  const sockets = new Set();
  let connects = 0;
  let nextId = 1;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
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
      if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
      if (packet.cmd === 'disconnect') socket.end();
    });
    socket.on('data', (data) => parser.parse(data));
    socket.on('error', () => undefined);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.notEqual(port, 1883);
  t.after(() => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(resolve); }));
  return {
    port,
    url: `mqtt://127.0.0.1:${port}`,
    packets,
    connects: () => connects,
    subscribed: () => packets.some((p) => p.cmd === 'subscribe'),
    /** Live (not retained) QoS 0 publish to every connected client. */
    publish(topic, payload) {
      for (const socket of sockets) {
        socket.write(mqttPacket.generate({ cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain: false, dup: false, messageId: nextId++ }));
      }
    },
    /** Payloads published by the clients on `topic`, parsed as JSON. */
    published(topic) {
      return packets.filter((p) => p.cmd === 'publish' && p.topic === topic && p.payload.length > 0)
        .map((p) => JSON.parse(p.payload.toString()));
    },
  };
}

module.exports = { startFakeBroker };
