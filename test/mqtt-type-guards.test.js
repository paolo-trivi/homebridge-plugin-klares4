const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isMqttLightCommand,
  isMqttCoverCommand,
  isMqttThermostatCommand,
  isMqttScenarioCommand,
} = require('../dist/types.js');

test('isMqttLightCommand validates on/brightness boundaries', () => {
  assert.equal(isMqttLightCommand({ on: true, brightness: 50 }), true);
  assert.equal(isMqttLightCommand({ on: false, brightness: 0 }), true);
  assert.equal(isMqttLightCommand({ brightness: 100 }), true);
  assert.equal(isMqttLightCommand({ brightness: -1 }), false);
  assert.equal(isMqttLightCommand({ brightness: 101 }), false);
  assert.equal(isMqttLightCommand({ on: 'true' }), false);
});

test('isMqttCoverCommand validates position range and number type', () => {
  assert.equal(isMqttCoverCommand({ position: 0 }), true);
  assert.equal(isMqttCoverCommand({ position: 100 }), true);
  assert.equal(isMqttCoverCommand({ position: 55.5 }), true);
  assert.equal(isMqttCoverCommand({ position: -1 }), false);
  assert.equal(isMqttCoverCommand({ position: 101 }), false);
  assert.equal(isMqttCoverCommand({ position: '50' }), false);
});

test('isMqttThermostatCommand validates mode enum and targetTemperature range', () => {
  assert.equal(isMqttThermostatCommand({ mode: 'off' }), true);
  assert.equal(isMqttThermostatCommand({ mode: 'heat', targetTemperature: 21 }), true);
  assert.equal(isMqttThermostatCommand({ mode: 'auto', targetTemperature: 5 }), true);
  assert.equal(isMqttThermostatCommand({ mode: 'cool', targetTemperature: 40 }), true);
  assert.equal(isMqttThermostatCommand({ mode: 'invalid' }), false);
  assert.equal(isMqttThermostatCommand({ targetTemperature: 4.9 }), false);
  assert.equal(isMqttThermostatCommand({ targetTemperature: 40.1 }), false);
  assert.equal(isMqttThermostatCommand({ targetTemperature: '21' }), false);
});

test('isMqttScenarioCommand accepts only boolean active', () => {
  assert.equal(isMqttScenarioCommand({ active: true }), true);
  assert.equal(isMqttScenarioCommand({ active: false }), true);
  assert.equal(isMqttScenarioCommand({ active: 'true' }), false);
});
