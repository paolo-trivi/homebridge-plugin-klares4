const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { MatterFallbackStore } = require('../dist/platform/matter-fallback-store.js');

const FILE = 'klares4-matter-fallback.json';
const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function storage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-fallback-'));
}

test('migrates the legacy set to v2 without losing device IDs', () => {
  const dir = storage();
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({
    thermostatAsTemperatureSensor: ['thermostat_18'],
  }));
  const store = new MatterFallbackStore(dir, log);

  assert.deepEqual([...store.load()], ['thermostat_18']);
  assert.equal(store.beginRecovery('thermostat_18', 1), true);

  const saved = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.thermostats[0].lastProcessedRecoveryRequest, 1);
  assert.equal(fs.existsSync(`${path.join(dir, FILE)}.v1.bak`), true);
});

test('a recovery generation is consumed only once', () => {
  const dir = storage();
  const store = new MatterFallbackStore(dir, log);
  store.add('thermostat_18');

  assert.equal(store.beginRecovery('thermostat_18', 1), true);
  store.add('thermostat_18', 'retry-failed');
  assert.equal(store.beginRecovery('thermostat_18', 1), false);
  assert.equal(store.beginRecovery('thermostat_18', 2), true);
});

test('an interrupted recovery deterministically returns to fallback on restart', () => {
  const dir = storage();
  const first = new MatterFallbackStore(dir, log);
  first.add('thermostat_18');
  first.beginRecovery('thermostat_18', 1);

  const restarted = new MatterFallbackStore(dir, log);
  assert.deepEqual([...restarted.load()], ['thermostat_18']);
  assert.equal(restarted.getRecord('thermostat_18').reason, 'interrupted-recovery');
});

test('successful recovery remains native across restart', () => {
  const dir = storage();
  const store = new MatterFallbackStore(dir, log);
  store.add('thermostat_18');
  store.beginRecovery('thermostat_18', 1);
  store.markNative('thermostat_18');

  assert.deepEqual([...new MatterFallbackStore(dir, log).load()], []);
});

test('F32: a store written by a newer version is left untouched (read-only)', () => {
  const dir = storage();
  const file = path.join(dir, FILE);
  const future = JSON.stringify({ version: 3, thermostats: [{ deviceId: 'thermostat_18', mode: 'fallback' }], extra: true });
  fs.writeFileSync(file, future);
  const warnings = [];
  const store = new MatterFallbackStore(dir, { ...log, warn: (m) => warnings.push(m) });

  assert.deepEqual([...store.load()], []);
  store.add('thermostat_19');
  assert.equal(store.has('thermostat_19'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), future);
  assert.equal(fs.existsSync(`${file}.v1.bak`), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /version 3/);
});

test('F32: the store is replaced by rename and leaves no temp file', () => {
  const dir = storage();
  const renames = [];
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => { renames.push([from, to]); return originalRename(from, to); };
  try {
    new MatterFallbackStore(dir, log).add('thermostat_18');
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], path.join(dir, FILE));
  assert.deepEqual(fs.readdirSync(dir), [FILE]);
});
