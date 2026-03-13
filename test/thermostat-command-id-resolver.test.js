const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveThermostatCommandId } = require('../dist/websocket-client/thermostat-command-id-resolver.js');

test('returns cached command id without probing candidates', async () => {
  let primeCalls = 0;
  const remembered = [];

  const resolved = await resolveThermostatCommandId({
    outputThermostatId: '21',
    hasProgramMapping: false,
    cachedCommandId: '4',
    primeConfig: async () => {
      primeCalls += 1;
      return true;
    },
    rememberCommandId: (id) => remembered.push(id),
  });

  assert.equal(resolved, '4');
  assert.equal(primeCalls, 0);
  assert.deepEqual(remembered, []);
});

test('manual command id override has precedence when valid', async () => {
  const remembered = [];
  const aliases = [];

  const resolved = await resolveThermostatCommandId({
    outputThermostatId: '21',
    hasProgramMapping: true,
    manualCommandId: '3',
    programCommandId: '4',
    primeConfig: async (candidateId) => candidateId === '3',
    rememberCommandId: (id) => remembered.push(id),
    onResolvedAlias: (id) => aliases.push(id),
  });

  assert.equal(resolved, '3');
  assert.deepEqual(remembered, ['3']);
  assert.deepEqual(aliases, ['3']);
});

test('uses PRG_THERMOSTATS command id before cached or output id', async () => {
  const remembered = [];
  const aliases = [];

  const resolved = await resolveThermostatCommandId({
    outputThermostatId: '21',
    hasProgramMapping: true,
    cachedCommandId: '4',
    programCommandId: '3',
    primeConfig: async (candidateId) => candidateId === '3',
    rememberCommandId: (id) => remembered.push(id),
    onResolvedAlias: (id) => aliases.push(id),
  });

  assert.equal(resolved, '3');
  assert.deepEqual(remembered, ['3']);
  assert.deepEqual(aliases, ['3']);
});

test('falls back to output id only when PRG_THERMOSTATS is unavailable', async () => {
  const remembered = [];

  const resolved = await resolveThermostatCommandId({
    outputThermostatId: '19',
    hasProgramMapping: false,
    primeConfig: async (candidateId) => candidateId === '19',
    rememberCommandId: (id) => remembered.push(id),
  });

  assert.equal(resolved, '19');
  assert.deepEqual(remembered, ['19']);
});

test('uses mapped domus sensor id as degraded fallback candidate before output id', async () => {
  const remembered = [];
  const aliases = [];

  const resolved = await resolveThermostatCommandId({
    outputThermostatId: '21',
    hasProgramMapping: false,
    mappedDomusSensorId: '3',
    primeConfig: async (candidateId) => candidateId === '3',
    rememberCommandId: (id) => remembered.push(id),
    onResolvedAlias: (id) => aliases.push(id),
  });

  assert.equal(resolved, '3');
  assert.deepEqual(remembered, ['3']);
  assert.deepEqual(aliases, ['3']);
});
