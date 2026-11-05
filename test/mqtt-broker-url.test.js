const test = require('node:test');
const assert = require('node:assert/strict');

const { maskBrokerUrl } = require('../dist/mqtt/broker-url.js');

test('maskBrokerUrl hides the userinfo of a broker URL', () => {
  assert.equal(maskBrokerUrl('mqtt://user:pass@host:1883'), 'mqtt://***@host:1883');
  assert.equal(maskBrokerUrl('mqtts://user@host:8883/path'), 'mqtts://***@host:8883/path');
  assert.equal(maskBrokerUrl('ws://u:p%40ss@host/mqtt'), 'ws://***@host/mqtt');
});

test('maskBrokerUrl leaves URLs without credentials untouched', () => {
  assert.equal(maskBrokerUrl('mqtt://192.168.1.5:1883'), 'mqtt://192.168.1.5:1883');
  assert.equal(maskBrokerUrl('wss://broker.example/mqtt?x=a@b'), 'wss://broker.example/mqtt?x=a@b');
  assert.equal(maskBrokerUrl('not a url'), 'not a url');
});

test('maskBrokerUrl masks a password containing an unescaped @', () => {
  assert.equal(maskBrokerUrl('mqtt://user:p@ss@host:1883'), 'mqtt://***@host:1883');
});
