const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseDeviceId,
  stripDevicePrefix,
  buildDeviceId,
  isOutputLikeDevice,
} = require('../dist/device-id.js');

test('parseDeviceId parses known prefixed ids', () => {
  assert.deepEqual(parseDeviceId('light_12'), { prefix: 'light_', rawId: '12' });
  assert.deepEqual(parseDeviceId('sensor_temp_5'), { prefix: 'sensor_temp_', rawId: '5' });
});

test('parseDeviceId falls back for unknown ids', () => {
  assert.deepEqual(parseDeviceId('sensor_system_temp_in'), {
    prefix: null,
    rawId: 'sensor_system_temp_in',
  });
});

test('stripDevicePrefix removes known prefixes only', () => {
  assert.equal(stripDevicePrefix('cover_9'), '9');
  assert.equal(stripDevicePrefix('sensor_system_temp_out'), 'sensor_system_temp_out');
});

test('buildDeviceId composes a canonical id', () => {
  assert.equal(buildDeviceId('thermostat_', 3), 'thermostat_3');
});

test('isOutputLikeDevice matches light/cover/gate/thermostat', () => {
  assert.equal(isOutputLikeDevice({ type: 'light' }), true);
  assert.equal(isOutputLikeDevice({ type: 'cover' }), true);
  assert.equal(isOutputLikeDevice({ type: 'gate' }), true);
  assert.equal(isOutputLikeDevice({ type: 'thermostat' }), true);
  assert.equal(isOutputLikeDevice({ type: 'sensor' }), false);
  assert.equal(isOutputLikeDevice({ type: 'zone' }), false);
});
