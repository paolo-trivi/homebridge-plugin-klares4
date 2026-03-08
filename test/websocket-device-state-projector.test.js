const test = require('node:test');
const assert = require('node:assert/strict');

const {
  determineOutputType,
  parseOutputDevice,
  parseIntegerInRange,
  parseFloatInRange,
  mapCoverPosition,
  mapCoverState,
} = require('../dist/websocket/device-state-projector.js');

test('determineOutputType preserves output classification contract', () => {
  assert.equal(determineOutputType('LIGHT'), 'light');
  assert.equal(determineOutputType('ROLL'), 'cover');
  assert.equal(determineOutputType('GATE', 'M'), 'gate');
  assert.equal(determineOutputType('GATE', 'B'), 'cover');
  assert.equal(determineOutputType('THERMOSTAT'), 'thermostat');
  assert.equal(determineOutputType('UNKNOWN'), 'light');
});

test('parseOutputDevice creates thermostat with aligned fields', () => {
  const thermostat = parseOutputDevice({
    ID: '7',
    DES: 'Termostato Test',
    TYPE: 'THERM',
    STATUS: '0',
    ENABLED: 'YES',
    CAT: 'THERM',
  });

  assert.equal(thermostat.type, 'thermostat');
  assert.equal(thermostat.status.currentTemperature, thermostat.currentTemperature);
  assert.equal(thermostat.status.targetTemperature, thermostat.targetTemperature);
  assert.equal(thermostat.status.mode, thermostat.mode);
});

test('numeric parsing and cover mapping clamp values safely', () => {
  assert.equal(parseIntegerInRange('101', 0, 100), 100);
  assert.equal(parseIntegerInRange('-10', 0, 100), 0);
  assert.equal(parseIntegerInRange('abc', 0, 100), undefined);

  assert.equal(parseFloatInRange('+21.4', 5, 40), 21.4);
  assert.equal(parseFloatInRange('21,5', 5, 40), 21.5);
  assert.equal(parseFloatInRange('99', 5, 40), 40);

  assert.equal(mapCoverPosition('UP', undefined), 100);
  assert.equal(mapCoverPosition('DOWN', undefined), 0);
  assert.equal(mapCoverState('STOP', '10', '10'), 'stopped');
  assert.equal(mapCoverState('STOP', '10', '90'), 'opening');
  assert.equal(mapCoverState('STOP', '90', '10'), 'closing');
});
