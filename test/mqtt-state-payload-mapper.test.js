const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeviceStatePayload } = require('../dist/mqtt/state-payload-mapper.js');

test('createDeviceStatePayload keeps light payload shape', () => {
  const payload = createDeviceStatePayload({
    id: 'light_1',
    name: 'Luce Sala',
    description: 'Luce Sala',
    type: 'light',
    status: { on: true, brightness: 80, dimmable: true },
  });

  assert.equal(payload.type, 'light');
  assert.equal(payload.on, true);
  assert.equal(payload.brightness, 80);
  assert.equal(payload.dimmable, true);
  assert.ok(typeof payload.timestamp === 'string');
});

test('createDeviceStatePayload keeps thermostat payload shape', () => {
  const payload = createDeviceStatePayload({
    id: 'thermostat_2',
    name: 'Termostato Zona Giorno',
    description: 'Termostato Zona Giorno',
    type: 'thermostat',
    status: { currentTemperature: 21, targetTemperature: 22, mode: 'heat' },
    currentTemperature: 21,
    targetTemperature: 22,
    mode: 'heat',
    humidity: 40,
  });

  assert.equal(payload.type, 'thermostat');
  assert.equal(payload.currentTemperature, 21);
  assert.equal(payload.targetTemperature, 22);
  assert.equal(payload.mode, 'heat');
  assert.equal(payload.humidity, 40);
});
