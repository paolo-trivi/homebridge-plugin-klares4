const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MatterNameService } = require('../dist/platform/matter-name-service.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

function silentLog() {
    return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

const devices = [
    { id: 'zone_19', type: 'zone', name: 'Finestra Taverna' },
    { id: 'cover_1', type: 'cover', name: 'Finestra Taverna' },
    { id: 'light_12', type: 'light', name: 'Solaio' },
];

const STORE_FILE = 'klares4-matter-names.json';

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------

test('finalize persists the name-map to klares4-matter-names.json', (t) => {
    const dir = tmpStorage(t, 'klares4-namesvc-');
    const svc = new MatterNameService(dir, silentLog());
    const { entries, duplicates, persisted } = svc.finalize(devices);

    assert.equal(persisted, true, 'first finalize must write the store');
    assert.deepEqual(duplicates, []);
    assert.equal(entries.get('cover_1').name, 'Finestra Taverna');
    assert.equal(entries.get('zone_19').name, 'Finestra Taverna - Sens.');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, STORE_FILE), 'utf8'));
    assert.equal(onDisk.version, 2);
    const zone = onDisk.names.find((e) => e.uuid === 'zone_19');
    assert.equal(zone.name, 'Finestra Taverna - Sens.');
    assert.equal(zone.base, 'Finestra Taverna');
    assert.equal(zone.type, 'zone');
});

test('a fresh service reloads the persisted map: final names available BEFORE any finalize, in any resolve order', (t) => {
    const dir = tmpStorage(t, 'klares4-namesvc-');
    new MatterNameService(dir, silentLog()).finalize(devices);

    // Next boot: zone arrives FIRST (the order that used to give it the clean
    // name) — with the persisted map it must get the suffixed name immediately.
    const boot2 = new MatterNameService(dir, silentLog());
    assert.equal(boot2.resolveName(devices[0]), 'Finestra Taverna - Sens.');
    assert.equal(boot2.resolveName(devices[1]), 'Finestra Taverna');
    assert.equal(boot2.resolveName(devices[2]), 'Solaio');

    // And in the reverse order too, obviously.
    const boot3 = new MatterNameService(dir, silentLog());
    assert.equal(boot3.resolveName(devices[1]), 'Finestra Taverna');
    assert.equal(boot3.resolveName(devices[0]), 'Finestra Taverna - Sens.');
});

test('second finalize with the identical device set does not rewrite the store', (t) => {
    const dir = tmpStorage(t, 'klares4-namesvc-');
    const svc = new MatterNameService(dir, silentLog());
    assert.equal(svc.finalize(devices).persisted, true);
    assert.equal(svc.finalize(devices).persisted, false, 'unchanged map must not rewrite');

    const boot2 = new MatterNameService(dir, silentLog());
    assert.equal(boot2.finalize(devices).persisted, false, 'reloaded identical map must not rewrite');
});

test('device-set changes are persisted and reflected by resolveName after finalize', (t) => {
    const dir = tmpStorage(t, 'klares4-namesvc-');
    const svc = new MatterNameService(dir, silentLog());
    svc.finalize(devices);

    const withNewCover = [...devices, { id: 'cover_9', type: 'cover', name: 'Solaio' }];
    const result = svc.finalize(withNewCover);
    assert.equal(result.persisted, true, 'changed set must persist');
    // New cover displaces the light on the clean "Solaio" slot? No: same
    // priority (10) — smaller uuid wins. 'cover_9' < 'light_12' → cover wins.
    assert.equal(result.entries.get('cover_9').name, 'Solaio');
    assert.equal(svc.resolveName(devices[2]), 'Solaio - Luce');
});

test('resolveName is stable across repeated calls (no churn, no re-resolution)', (t) => {
    const dir = tmpStorage(t, 'klares4-namesvc-');
    const svc = new MatterNameService(dir, silentLog());
    const first = svc.resolveName(devices[1]);
    for (let i = 0; i < 5; i++) assert.equal(svc.resolveName(devices[1]), first);
});

test('incremental fallback: unknown device never collides with seeded map names', (t) => {
    const dir = tmpStorage(t, 'klares4-namesvc-');
    new MatterNameService(dir, silentLog()).finalize(devices);

    const boot2 = new MatterNameService(dir, silentLog());
    // New same-priority device added on the panel, colliding with a mapped name.
    // 'light_50' > 'light_12' lexicographically → incumbent keeps the slot.
    const name = boot2.resolveName({ id: 'light_50', type: 'light', name: 'Solaio' });
    assert.notEqual(name.toLowerCase(), 'solaio');
    assert.equal(boot2.currentNameOf('light_12'), 'Solaio', 'seeded owner keeps its slot');
});

test('corrupt store file is tolerated (empty map, incremental fallback still works)', (t) => {
    const dir = tmpStorage(t, 'klares4-namesvc-');
    fs.writeFileSync(path.join(dir, STORE_FILE), '{ not json', 'utf8');
    const svc = new MatterNameService(dir, silentLog());
    assert.equal(svc.resolveName(devices[1]), 'Finestra Taverna');
});

test('store entries missing required fields are skipped on load', (t) => {
    const dir = tmpStorage(t, 'klares4-namesvc-');
    fs.writeFileSync(path.join(dir, STORE_FILE), JSON.stringify({
        version: 1,
        names: [
            { uuid: 'cover_1', name: 'Finestra Taverna', base: 'Finestra Taverna', type: 'cover' },
            { uuid: '', name: 'Broken', base: 'Broken' },
            { name: 'No uuid', base: 'No uuid' },
            null,
        ],
    }), 'utf8');
    const svc = new MatterNameService(dir, silentLog());
    assert.equal(svc.currentNameOf('cover_1'), 'Finestra Taverna');
    assert.equal(svc.currentNameOf(''), undefined);
});

test('v2 store rejects missing timestamps, unsupported versions and duplicate slots', (t) => {
    const invalidTimestampDir = tmpStorage(t, 'klares4-namesvc-');
    fs.writeFileSync(path.join(invalidTimestampDir, STORE_FILE), JSON.stringify({
        version: 2,
        names: [{ uuid: 'cover_1', name: 'Finestra Taverna', base: 'Finestra Taverna', type: 'cover' }],
    }), 'utf8');
    assert.equal(new MatterNameService(invalidTimestampDir, silentLog()).currentNameOf('cover_1'), undefined);

    const unsupportedDir = tmpStorage(t, 'klares4-namesvc-');
    fs.writeFileSync(path.join(unsupportedDir, STORE_FILE), JSON.stringify({
        version: 99,
        names: [{ uuid: 'cover_1', name: 'Finestra Taverna', base: 'Finestra Taverna', lastSeen: Date.now() }],
    }), 'utf8');
    assert.equal(new MatterNameService(unsupportedDir, silentLog()).currentNameOf('cover_1'), undefined);

    const duplicateDir = tmpStorage(t, 'klares4-namesvc-');
    fs.writeFileSync(path.join(duplicateDir, STORE_FILE), JSON.stringify({
        version: 2,
        names: [
            { uuid: 'zone_1', name: 'Solaio', base: 'Solaio', type: 'zone', lastSeen: Date.now() },
            { uuid: 'light_1', name: 'solaio', base: 'solaio', type: 'light', lastSeen: Date.now() },
        ],
    }), 'utf8');
    const duplicateService = new MatterNameService(duplicateDir, silentLog());
    assert.equal(duplicateService.currentNameOf('light_1'), 'solaio');
    assert.equal(duplicateService.currentNameOf('zone_1'), undefined);
    duplicateService.finalize([{ id: 'light_1', type: 'light', name: 'solaio' }]);
    const repaired = JSON.parse(fs.readFileSync(path.join(duplicateDir, STORE_FILE), 'utf8'));
    assert.equal(repaired.names.length, 1, 'discarded entries must be removed from disk on finalize');
});

test('v1 migration writes a backup before the first atomic v2 write', (t) => {
    const dir = tmpStorage(t, 'klares4-namesvc-');
    fs.writeFileSync(path.join(dir, STORE_FILE), JSON.stringify({
        version: 1,
        names: [{ uuid: 'cover_1', name: 'Finestra Taverna', base: 'Finestra Taverna', type: 'cover' }],
    }), 'utf8');
    const svc = new MatterNameService(dir, silentLog());
    svc.finalize([{ id: 'cover_1', type: 'cover', name: 'Finestra Taverna' }]);

    assert.equal(fs.existsSync(path.join(dir, `${STORE_FILE}.v1.bak`)), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, STORE_FILE), 'utf8')).version, 2);
});
