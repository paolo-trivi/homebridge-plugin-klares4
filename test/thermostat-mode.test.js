const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseKseniaMode,
  domainModeToHomeKitTarget,
  homeKitTargetToDomainMode,
  deriveHomeKitCurrentState,
} = require('../dist/thermostat-mode.js');

test('parseKseniaMode supports numeric and textual aliases, and does not turn an unknown value into off', () => {
  assert.equal(parseKseniaMode('1'), 'heat');
  assert.equal(parseKseniaMode('2'), 'cool');
  assert.equal(parseKseniaMode('3'), 'auto');
  assert.equal(parseKseniaMode('riscaldamento'), 'heat');
  assert.equal(parseKseniaMode('raffreddamento'), 'cool');
  assert.equal(parseKseniaMode('spento'), 'off');
  assert.equal(parseKseniaMode('unexpected'), undefined);
});

test('homekit target mapping is symmetric with domain values', () => {
  assert.equal(domainModeToHomeKitTarget('off'), 0);
  assert.equal(domainModeToHomeKitTarget('heat'), 1);
  assert.equal(domainModeToHomeKitTarget('cool'), 2);
  assert.equal(domainModeToHomeKitTarget('auto'), 3);

  assert.equal(homeKitTargetToDomainMode(0), 'off');
  assert.equal(homeKitTargetToDomainMode(1), 'heat');
  assert.equal(homeKitTargetToDomainMode(2), 'cool');
  assert.equal(homeKitTargetToDomainMode(3), 'auto');
  assert.equal(homeKitTargetToDomainMode(99), 'off');
});

test('deriveHomeKitCurrentState keeps existing behavior', () => {
  assert.equal(deriveHomeKitCurrentState('off', 20, 21), 0);
  assert.equal(deriveHomeKitCurrentState('heat', 19, 21), 1);
  assert.equal(deriveHomeKitCurrentState('heat', 24, 21), 0);
  assert.equal(deriveHomeKitCurrentState('cool', 24, 21), 2);
  assert.equal(deriveHomeKitCurrentState('cool', 19, 21), 0);
  assert.equal(deriveHomeKitCurrentState('auto', 21, 21), 0);
});

test('deriveHomeKitCurrentState prefers realtime HVAC activity when available', () => {
  assert.equal(deriveHomeKitCurrentState('heat', 24, 21, true), 1);
  assert.equal(deriveHomeKitCurrentState('cool', 19, 21, true), 2);
  assert.equal(deriveHomeKitCurrentState('heat', 19, 21, false), 0);
  assert.equal(deriveHomeKitCurrentState('cool', 24, 21, false), 0);
});
