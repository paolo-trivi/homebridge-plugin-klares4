const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveThermostatCommandId } = require('../dist/websocket-client/thermostat-command-id-resolver.js');

test('returns cached command id without probing candidates', async () => {
  let primeCalls = 0;
  const remembered = [];

  const resolved = await resolveThermostatCommandId({
    outputThermostatId: '21',
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
    manualCommandId: '3',
    mappedDomusSensorId: '4',
    primeConfig: async (candidateId) => candidateId === '3',
    rememberCommandId: (id) => remembered.push(id),
    onResolvedAlias: (id) => aliases.push(id),
  });

  assert.equal(resolved, '3');
  assert.deepEqual(remembered, ['3']);
  assert.deepEqual(aliases, ['3']);
});

test('falls back to mapped sensor id when output id is not a valid command id', async () => {
  const remembered = [];
  const aliases = [];

  const resolved = await resolveThermostatCommandId({
    outputThermostatId: '19',
    mappedDomusSensorId: '5',
    primeConfig: async (candidateId) => candidateId === '5',
    rememberCommandId: (id) => remembered.push(id),
    onResolvedAlias: (id) => aliases.push(id),
  });

  assert.equal(resolved, '5');
  assert.deepEqual(remembered, ['5']);
  assert.deepEqual(aliases, ['5']);
});
