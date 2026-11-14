'use strict';

// `mqtt.commands` in the runtime config (SP-04) and the broker URL helpers
// (SP-14). Nothing here opens a connection: the helpers are pure.

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveRuntimeConfig, toPlatformConfig } = require('../dist/platform/runtime-config.js');
const { maskBrokerUrl, checkBrokerUrl } = require('../dist/mqtt/broker-url.js');
const { recordingLog } = require('./fixtures/fake-mqtt.js');

function resolve(mqtt) {
  const log = recordingLog();
  const raw = { ip: '192.0.2.1', pin: '1', mqtt: { enabled: true, broker: 'mqtt://broker.example', ...mqtt } };
  const runtime = resolveRuntimeConfig(raw, log.logger);
  return { runtime, config: toPlatformConfig(raw, runtime), log };
}

test('SP-04: mqtt.commands defaults to true and reaches the platform config', () => {
  const { runtime, config } = resolve({});
  assert.equal(runtime.mqtt.commands, true);
  assert.equal(config.mqtt.commands, true);
});

test('SP-04: mqtt.commands:false turns commands off', () => {
  const { runtime, config } = resolve({ commands: false });
  assert.equal(runtime.mqtt.commands, false);
  assert.equal(config.mqtt.commands, false);
});

test('SP-04: a mqtt.commands that is not a boolean keeps the default and is reported', () => {
  const { runtime, log } = resolve({ commands: 'false' });
  assert.equal(runtime.mqtt.commands, true);
  assert.ok(log.all().includes('mqtt.commands'), log.all());
});

test('SP-14: maskBrokerUrl hides credentials with surrounding spaces or without a scheme', () => {
  assert.equal(maskBrokerUrl(' mqtt://mario:Sup3r@127.0.0.1:1884'), 'mqtt://***@127.0.0.1:1884');
  assert.equal(maskBrokerUrl('mario:Sup3r@broker.example:1883'), '***@broker.example:1883');
  assert.equal(maskBrokerUrl('MQTT://USER:Pw@broker.example'), 'MQTT://***@broker.example');
  assert.equal(maskBrokerUrl('tcp://u:p@h:1883 '), 'tcp://***@h:1883');
});

test('SP-14: checkBrokerUrl describes the broker without credentials', () => {
  assert.deepEqual(checkBrokerUrl(' mqtts://u:p%40ss@broker.example:8883 '), {
    ok: true, url: 'mqtts://u:p%40ss@broker.example:8883', display: 'mqtts://broker.example:8883',
  });
  assert.equal(checkBrokerUrl('ws://broker.example/mqtt').display, 'ws://broker.example');
  assert.equal(checkBrokerUrl('mqtt://[2001:db8::10]:1884').display, 'mqtt://[2001:db8::10]:1884');
  assert.equal(checkBrokerUrl('mqtt://user:p@ss@broker.example').display, 'mqtt://broker.example');
});

test('SP-23: checkBrokerUrl refuses what mqtt.js would read as another host', () => {
  for (const url of ['broker.example', 'broker.example:1883', '192.0.2.5', 'u:p@broker.example', 'mqtt:/u:p@broker.example', 'http://broker.example', 'mqtt://u:p/ss@broker.example', 'mqtt://', '']) {
    const result = checkBrokerUrl(url);
    assert.equal(result.ok, false, url);
    assert.ok(!result.reason.includes('broker.example') && !result.reason.includes('u:p'), result.reason);
  }
});
