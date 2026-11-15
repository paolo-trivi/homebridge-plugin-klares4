const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveThermostatCommandId } = require('../dist/websocket-client/thermostat-command-id-resolver.js');

function input(overrides) {
  const remembered = [];
  const aliases = [];
  return {
    remembered,
    aliases,
    args: {
      outputThermostatId: '21',
      hasProgramMapping: false,
      primeConfig: async () => true,
      verifyGuess: async () => ({ accepted: true, remember: true }),
      rememberCommandId: (id) => remembered.push(id),
      onResolvedAlias: (id) => aliases.push(id),
      ...overrides,
    },
  };
}

test('a verified cached guess is reused after its cfg is primed', async () => {
  const probed = [];
  const h = input({ cachedCommandId: '4', primeConfig: async (id) => { probed.push(id); return true; } });
  assert.deepEqual(await resolveThermostatCommandId(h.args), { id: '4', source: 'degraded' });
  assert.deepEqual(probed, ['4']);
});

test('manual command id override has precedence when valid', async () => {
  const h = input({ hasProgramMapping: true, manualCommandId: '3', programCommandId: '4', primeConfig: async (id) => id === '3' });
  assert.deepEqual(await resolveThermostatCommandId(h.args), { id: '3', source: 'manual' });
  assert.deepEqual(h.remembered, ['3']);
  assert.deepEqual(h.aliases, ['3']);
});

test('TH-04: an unreadable manual cfg id is refused, the program id is not tried', async () => {
  const probed = [];
  const h = input({ hasProgramMapping: true, manualCommandId: '7', programCommandId: '4', primeConfig: async (id) => { probed.push(id); return id === '4'; } });
  await assert.rejects(() => resolveThermostatCommandId(h.args), /cfg id 7 \(from domusThermostat.manualCommandPairs\)/);
  assert.deepEqual(probed, ['7']);
  assert.deepEqual(h.remembered, []);
});

test('uses PRG_THERMOSTATS command id before cached or output id', async () => {
  const h = input({ hasProgramMapping: true, cachedCommandId: '4', programCommandId: '3', primeConfig: async (id) => id === '3' });
  assert.deepEqual(await resolveThermostatCommandId(h.args), { id: '3', source: 'program' });
  assert.deepEqual(h.remembered, ['3']);
});

test('TH-04: an unreadable program cfg id is refused instead of writing the output id', async () => {
  const h = input({ hasProgramMapping: true, programCommandId: '3', primeConfig: async () => false });
  await assert.rejects(() => resolveThermostatCommandId(h.args), /cfg id 3 \(from PRG_THERMOSTATS\)/);
});

test('falls back to output id only when PRG_THERMOSTATS is unavailable', async () => {
  const h = input({ outputThermostatId: '19', primeConfig: async (id) => id === '19' });
  assert.deepEqual(await resolveThermostatCommandId(h.args), { id: '19', source: 'degraded' });
  assert.deepEqual(h.remembered, ['19']);
});

test('uses mapped domus sensor id as degraded fallback candidate before output id', async () => {
  const h = input({ mappedDomusSensorId: '3', primeConfig: async (id) => id === '3' });
  assert.deepEqual(await resolveThermostatCommandId(h.args), { id: '3', source: 'degraded' });
  assert.deepEqual(h.aliases, ['3']);
});

test('TH-04: a degraded guess that does not match the realtime is refused', async () => {
  const h = input({ mappedDomusSensorId: '3', verifyGuess: async () => ({ accepted: false, reason: 'cfg 3 does not match' }) });
  await assert.rejects(() => resolveThermostatCommandId(h.args), /does not match/);
  assert.deepEqual(h.remembered, []);
});

test('M2: a guess accepted without a discriminating match is used but not remembered', async () => {
  const h = input({ mappedDomusSensorId: '3', verifyGuess: async () => ({ accepted: true, remember: false }) });
  assert.deepEqual(await resolveThermostatCommandId(h.args), { id: '3', source: 'degraded' });
  assert.deepEqual(h.remembered, []);
});

test('TH-04: nothing readable in the degraded path: refused', async () => {
  const h = input({ mappedDomusSensorId: '3', primeConfig: async () => false });
  await assert.rejects(() => resolveThermostatCommandId(h.args), /no cfg could be read/);
});
