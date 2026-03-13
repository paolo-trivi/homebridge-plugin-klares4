const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDefaultThermostatState,
  syncThermostatTopLevelFromStatus,
  updateThermostatStatus,
} = require('../dist/thermostat-state.js');

test('createDefaultThermostatState keeps status and top-level aligned', () => {
  const state = createDefaultThermostatState();
  assert.equal(state.status.currentTemperature, state.currentTemperature);
  assert.equal(state.status.targetTemperature, state.targetTemperature);
  assert.equal(state.status.mode, state.mode);
});

test('syncThermostatTopLevelFromStatus aligns duplicated compatibility fields', () => {
  const device = {
    status: { currentTemperature: 20, targetTemperature: 21, mode: 'heat' },
    currentTemperature: 0,
    targetTemperature: 0,
    mode: 'off',
  };

  syncThermostatTopLevelFromStatus(device);

  assert.equal(device.currentTemperature, 20);
  assert.equal(device.targetTemperature, 21);
  assert.equal(device.mode, 'heat');
});

test('updateThermostatStatus updates status and top-level in a single operation', () => {
  const device = {
    status: { currentTemperature: 20, targetTemperature: 21, mode: 'off' },
    currentTemperature: 20,
    targetTemperature: 21,
    mode: 'off',
  };

  const changed = updateThermostatStatus(device, {
    currentTemperature: 23,
    targetTemperature: 24,
    mode: 'cool',
  });

  assert.equal(changed, true);
  assert.equal(device.status.currentTemperature, 23);
  assert.equal(device.currentTemperature, 23);
  assert.equal(device.status.targetTemperature, 24);
  assert.equal(device.targetTemperature, 24);
  assert.equal(device.status.mode, 'cool');
  assert.equal(device.mode, 'cool');
});

test('updateThermostatStatus stores realtime HVAC activity without touching top-level compatibility fields', () => {
  const device = {
    status: { currentTemperature: 20, targetTemperature: 21, mode: 'heat' },
    currentTemperature: 20,
    targetTemperature: 21,
    mode: 'heat',
  };

  const changed = updateThermostatStatus(device, {
    hvacOutputActive: true,
  });

  assert.equal(changed, true);
  assert.equal(device.status.hvacOutputActive, true);
  assert.equal(device.currentTemperature, 20);
  assert.equal(device.targetTemperature, 21);
  assert.equal(device.mode, 'heat');
});
