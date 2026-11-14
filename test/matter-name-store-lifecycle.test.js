'use strict';

// MAT-06: `lastSeen` of the devices still on the panel is refreshed, so a
// reservation expires 30 days after the device was last seen and the names of
// live devices never expire. MAT-11: the name store is written atomically and
// never overwrites a file of a newer version.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MatterNameService } = require('../dist/platform/matter-name-service.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const STORE_FILE = 'klares4-matter-names.json';
const DAY = 24 * 60 * 60 * 1000;
const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {} });

function recordingLog() {
    const lines = [];
    return { lines, info() {}, debug() {}, error: (m) => lines.push(m), warn: (m) => lines.push(m) };
}

function writeStore(dir, names, version = 2) {
    fs.writeFileSync(path.join(dir, STORE_FILE), JSON.stringify({ version, names }, null, 2), 'utf8');
}
const readStore = (dir) => JSON.parse(fs.readFileSync(path.join(dir, STORE_FILE), 'utf8'));
const row = (uuid, name, type, ageDays, base = name) => ({ uuid, name, base, type, lastSeen: Date.now() - ageDays * DAY });

const devices = [
    { id: 'cover_1', type: 'cover', name: 'Vetrata' },
    { id: 'zone_2', type: 'zone', name: 'Vetrata' },
];

test('MAT-06: a boot with the devices on the panel refreshes lastSeen on disk once it is a day old', (t) => {
    const dir = tmpStorage(t, 'klares4-names-ttl-');
    writeStore(dir, [row('cover_1', 'Vetrata', 'cover', 2), row('zone_2', 'Vetrata - Sens.', 'zone', 2, 'Vetrata')]);

    const service = new MatterNameService(dir, silentLog());
    service.finalize(devices);

    for (const entry of readStore(dir).names) {
        assert.ok(Date.now() - entry.lastSeen < DAY, `${entry.uuid} lastSeen refreshed`);
    }
});

test('MAT-06: lastSeen younger than a day is not rewritten on every boot', (t) => {
    const dir = tmpStorage(t, 'klares4-names-ttl-');
    const fresh = [row('cover_1', 'Vetrata', 'cover', 0.5), row('zone_2', 'Vetrata - Sens.', 'zone', 0.5, 'Vetrata')];
    writeStore(dir, fresh);
    const before = fs.readFileSync(path.join(dir, STORE_FILE), 'utf8');
    new MatterNameService(dir, silentLog()).finalize(devices);
    assert.equal(fs.readFileSync(path.join(dir, STORE_FILE), 'utf8'), before);
});

test('MAT-06: after more than 30 days of downtime the names of live devices are still known', (t) => {
    const dir = tmpStorage(t, 'klares4-names-ttl-');
    writeStore(dir, [row('cover_1', 'Vetrata', 'cover', 31), row('zone_2', 'Vetrata - Sens.', 'zone', 31, 'Vetrata')]);
    const log = recordingLog();
    const service = new MatterNameService(dir, log);
    // Phase 1: the zone, discovered first, registers with its final name.
    assert.equal(service.resolveName(devices[1]), 'Vetrata - Sens.');
    assert.equal(service.resolveName(devices[0]), 'Vetrata');
    assert.deepEqual(log.lines, []);
});

test('MAT-06: a reservation expires 30 days after the device was last seen, not after the last write', (t) => {
    const dir = tmpStorage(t, 'klares4-names-ttl-');
    writeStore(dir, [
        row('cover_1', 'Vetrata', 'cover', 0),
        row('light_3', 'Lampada', 'light', 29),
        row('light_4', 'Lampada vecchia', 'light', 31),
    ]);
    const { entries } = new MatterNameService(dir, silentLog()).finalize([devices[0]]);
    assert.equal(entries.get('light_3')?.reserved, true, 'seen 29 days ago: still reserved');
    assert.equal(Date.now() - entries.get('light_3').lastSeen >= 29 * DAY, true, 'a reservation keeps its own lastSeen');
    assert.equal(entries.has('light_4'), false, 'seen 31 days ago: released');
    assert.deepEqual(readStore(dir).names.map((n) => n.uuid).sort(), ['cover_1', 'light_3']);
});

test('MAT-11: a name store written by a newer version is neither used nor overwritten', (t) => {
    const dir = tmpStorage(t, 'klares4-names-store-');
    writeStore(dir, [{ uuid: 'cover_1', name: 'Vetrata', base: 'Vetrata', future: true }], 3);
    const before = fs.readFileSync(path.join(dir, STORE_FILE), 'utf8');
    const log = recordingLog();
    const service = new MatterNameService(dir, log);
    service.finalize(devices);
    assert.equal(fs.readFileSync(path.join(dir, STORE_FILE), 'utf8'), before);
    assert.equal(log.lines.filter((l) => /newer plugin version/.test(l)).length, 1);
    assert.deepEqual(fs.readdirSync(dir), [STORE_FILE]);
});

test('MAT-11: the name store is replaced atomically and keeps its permissions', (t) => {
    const dir = tmpStorage(t, 'klares4-names-store-');
    writeStore(dir, [row('cover_1', 'Vetrata', 'cover', 3)]);
    fs.chmodSync(path.join(dir, STORE_FILE), 0o600);
    new MatterNameService(dir, silentLog()).finalize(devices);
    assert.equal(readStore(dir).names.length, 2);
    assert.equal(fs.statSync(path.join(dir, STORE_FILE)).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), [STORE_FILE], 'no temporary file left behind');
});
