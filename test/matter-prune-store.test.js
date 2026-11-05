const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { MatterPruneTracker } = require('../dist/platform/matter-prune-tracker.js');

const FILE = 'klares4-matter-prune.json';
const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function storage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-prune-'));
}

test('F32: prune counters are written atomically', () => {
  const dir = storage();
  const tracker = new MatterPruneTracker(log, dir);
  const renames = [];
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => { renames.push([from, to]); return originalRename(from, to); };
  try {
    tracker.recordMissing('uuid-1', 'Luce Test');
    tracker['saveCountersIfDirty']();
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], path.join(dir, FILE));
  assert.deepEqual(fs.readdirSync(dir), [FILE]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')), { version: 1, missing: { 'uuid-1': 1 } });
});

test('F32: a counter store from a newer version is never rewritten', () => {
  const dir = storage();
  const file = path.join(dir, FILE);
  const future = JSON.stringify({ version: 2, missing: { 'uuid-1': 2 }, extra: true });
  fs.writeFileSync(file, future);
  const warnings = [];
  const tracker = new MatterPruneTracker({ ...log, warn: (m) => warnings.push(m) }, dir);
  tracker.recordMissing('uuid-2', 'Luce Test');
  tracker['saveCountersIfDirty']();
  assert.equal(fs.readFileSync(file, 'utf8'), future);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /version 2/);
});
