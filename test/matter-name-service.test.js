const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { MatterNameService } = require('../dist/platform/matter-name-service.js');

function tmpStorage() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-namesvc-'));
}

function silentLog() {
    return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

const devices = [
    { id: 'zone_19', type: 'zone', name: 'Finestra Cucina' },
    { id: 'cover_1', type: 'cover', name: 'Finestra Cucina' },
    { id: 'light_12', type: 'light', name: 'Studio' },
];

const STORE_FILE = 'klares4-matter-names.json';

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------

test('finalize persists the name-map to klares4-matter-names.json', () => {
    const dir = tmpStorage();
    const svc = new MatterNameService(dir, silentLog());
    const { entries, duplicates, persisted } = svc.finalize(devices);

    assert.equal(persisted, true, 'first finalize must write the store');
    assert.deepEqual(duplicates, []);
    assert.equal(entries.get('cover_1').name, 'Finestra Cucina');
    assert.equal(entries.get('zone_19').name, 'Finestra Cucina - Sens.');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, STORE_FILE), 'utf8'));
    assert.equal(onDisk.version, 1);
    const zone = onDisk.names.find((e) => e.uuid === 'zone_19');
    assert.equal(zone.name, 'Finestra Cucina - Sens.');
    assert.equal(zone.base, 'Finestra Cucina');
    assert.equal(zone.type, 'zone');
});

test('a fresh service reloads the persisted map: final names available BEFORE any finalize, in any resolve order', () => {
    const dir = tmpStorage();
    new MatterNameService(dir, silentLog()).finalize(devices);

    // Next boot: zone arrives FIRST (the order that used to give it the clean
    // name) — with the persisted map it must get the suffixed name immediately.
    const boot2 = new MatterNameService(dir, silentLog());
    assert.equal(boot2.resolveName(devices[0]), 'Finestra Cucina - Sens.');
    assert.equal(boot2.resolveName(devices[1]), 'Finestra Cucina');
    assert.equal(boot2.resolveName(devices[2]), 'Studio');

    // And in the reverse order too, obviously.
    const boot3 = new MatterNameService(dir, silentLog());
    assert.equal(boot3.resolveName(devices[1]), 'Finestra Cucina');
    assert.equal(boot3.resolveName(devices[0]), 'Finestra Cucina - Sens.');
});

test('second finalize with the identical device set does not rewrite the store', () => {
    const dir = tmpStorage();
    const svc = new MatterNameService(dir, silentLog());
    assert.equal(svc.finalize(devices).persisted, true);
    assert.equal(svc.finalize(devices).persisted, false, 'unchanged map must not rewrite');

    const boot2 = new MatterNameService(dir, silentLog());
    assert.equal(boot2.finalize(devices).persisted, false, 'reloaded identical map must not rewrite');
});

test('device-set changes are persisted and reflected by resolveName after finalize', () => {
    const dir = tmpStorage();
    const svc = new MatterNameService(dir, silentLog());
    svc.finalize(devices);

    const withNewCover = [...devices, { id: 'cover_9', type: 'cover', name: 'Studio' }];
    const result = svc.finalize(withNewCover);
    assert.equal(result.persisted, true, 'changed set must persist');
    // New cover displaces the light on the clean "Studio" slot? No: same
    // priority (10) — smaller uuid wins. 'cover_9' < 'light_12' → cover wins.
    assert.equal(result.entries.get('cover_9').name, 'Studio');
    assert.equal(svc.resolveName(devices[2]), 'Studio - Luce');
});

test('resolveName is stable across repeated calls (no churn, no re-resolution)', () => {
    const dir = tmpStorage();
    const svc = new MatterNameService(dir, silentLog());
    const first = svc.resolveName(devices[1]);
    for (let i = 0; i < 5; i++) assert.equal(svc.resolveName(devices[1]), first);
});

test('incremental fallback: unknown device never collides with seeded map names', () => {
    const dir = tmpStorage();
    new MatterNameService(dir, silentLog()).finalize(devices);

    const boot2 = new MatterNameService(dir, silentLog());
    // New same-priority device added on the panel, colliding with a mapped name.
    // 'light_50' > 'light_12' lexicographically → incumbent keeps the slot.
    const name = boot2.resolveName({ id: 'light_50', type: 'light', name: 'Studio' });
    assert.notEqual(name.toLowerCase(), 'studio');
    assert.equal(boot2.currentNameOf('light_12'), 'Studio', 'seeded owner keeps its slot');
});

// ---------------------------------------------------------------------------
// Name-slot reservations: a device missing from one sync must not lose its
// voice-command name to a lower-priority namesake. This is the "apri finestra"
// regression — a contact-sensor zone taking the clean name off the cover while
// the cover was briefly absent, leaving both endpoints answering to it.
// ---------------------------------------------------------------------------

const cover = { id: 'cover_1', type: 'cover', name: 'Finestra Cucina' };
const zone = { id: 'zone_19', type: 'zone', name: 'Finestra Cucina' };

test('a device absent from one sync keeps its name slot reserved', () => {
    const dir = tmpStorage();
    new MatterNameService(dir, silentLog()).finalize([cover, zone]);

    // Partial sync: the cover is not discovered this time round.
    const boot2 = new MatterNameService(dir, silentLog());
    const { entries } = boot2.finalize([zone]);

    assert.equal(entries.get('zone_19').name, 'Finestra Cucina - Sens.',
        'the zone must NOT be promoted to the clean name just because the cover is away');
    assert.equal(entries.get('cover_1').name, 'Finestra Cucina');
    assert.equal(entries.get('cover_1').reserved, true, 'absent device is kept as a reservation');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, STORE_FILE), 'utf8'));
    assert.deepEqual(onDisk.names.map((e) => e.uuid).sort(), ['cover_1', 'zone_19'],
        'the reservation must survive on disk');
});

test('sensor disappears and comes back: no duplicate name at registration time', () => {
    const dir = tmpStorage();
    new MatterNameService(dir, silentLog()).finalize([cover, zone]);

    // Sync 2: the zone is gone (pruned, or absent from a partial discovery).
    new MatterNameService(dir, silentLog()).finalize([cover]);

    // Sync 3: the zone is back. Phase 1 runs at registration time, before any
    // finalize, and with the zone arriving first — the order that used to hand
    // it the clean name.
    const boot3 = new MatterNameService(dir, silentLog());
    const zoneName = boot3.resolveName(zone);
    const coverName = boot3.resolveName(cover);

    assert.notEqual(zoneName.toLowerCase(), coverName.toLowerCase(),
        'two endpoints must never register under the same voice name');
    assert.equal(coverName, 'Finestra Cucina', 'the cover keeps the actionable clean name');
    assert.equal(zoneName, 'Finestra Cucina - Sens.');
});

test('reservations lose to a live higher-priority namesake, not the other way round', () => {
    const dir = tmpStorage();
    // A zone alone owns the clean name (nothing else claims it).
    const boot1 = new MatterNameService(dir, silentLog());
    assert.equal(boot1.finalize([zone]).entries.get('zone_19').name, 'Finestra Cucina');

    // The cover shows up later: priority moves the clean name to it and the
    // zone takes the suffix. Holding a slot never outranks type priority.
    const boot2 = new MatterNameService(dir, silentLog());
    const { entries } = boot2.finalize([cover, zone]);
    assert.equal(entries.get('cover_1').name, 'Finestra Cucina');
    assert.equal(entries.get('zone_19').name, 'Finestra Cucina - Sens.');
});

test('a reservation expires once it is older than the TTL', () => {
    const dir = tmpStorage();
    new MatterNameService(dir, silentLog()).finalize([cover, zone]);

    // Age the cover's stamp past the 30-day reservation window.
    const file = path.join(dir, STORE_FILE);
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of store.names) {
        if (entry.uuid === 'cover_1') entry.lastSeen = Date.now() - (31 * 24 * 60 * 60 * 1000);
    }
    fs.writeFileSync(file, JSON.stringify(store), 'utf8');

    const boot2 = new MatterNameService(dir, silentLog());
    assert.equal(boot2.currentNameOf('cover_1'), undefined, 'expired slot is released');
    // With the reservation gone the zone may take the clean name.
    assert.equal(boot2.finalize([zone]).entries.get('zone_19').name, 'Finestra Cucina');
});

test('lastSeen bookkeeping alone is not reported as a map change', () => {
    const dir = tmpStorage();
    const svc = new MatterNameService(dir, silentLog());
    assert.equal(svc.finalize([cover, zone]).persisted, true);
    // Same set again: stamps move, the mapping does not.
    assert.equal(svc.finalize([cover, zone]).persisted, false);
});

test('corrupt store file is tolerated (empty map, incremental fallback still works)', () => {
    const dir = tmpStorage();
    fs.writeFileSync(path.join(dir, STORE_FILE), '{ not json', 'utf8');
    const svc = new MatterNameService(dir, silentLog());
    assert.equal(svc.resolveName(devices[1]), 'Finestra Cucina');
});

test('store entries missing required fields are skipped on load', () => {
    const dir = tmpStorage();
    fs.writeFileSync(path.join(dir, STORE_FILE), JSON.stringify({
        version: 1,
        names: [
            { uuid: 'cover_1', name: 'Finestra Cucina', base: 'Finestra Cucina', type: 'cover' },
            { uuid: '', name: 'Broken', base: 'Broken' },
            { name: 'No uuid', base: 'No uuid' },
            null,
        ],
    }), 'utf8');
    const svc = new MatterNameService(dir, silentLog());
    assert.equal(svc.currentNameOf('cover_1'), 'Finestra Cucina');
    assert.equal(svc.currentNameOf(''), undefined);
});
