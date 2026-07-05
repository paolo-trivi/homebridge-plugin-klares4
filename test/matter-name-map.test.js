const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    computeMatterNameMap,
    findDuplicateDisplayNames,
} = require('../dist/platform/matter-name-map.js');

function names(map) {
    const out = {};
    for (const [uuid, entry] of map) out[uuid] = entry.name;
    return out;
}

// Deterministic pseudo-shuffle (mulberry32) — reproducible permutations.
function shuffled(arr, seed) {
    let a = seed >>> 0;
    const rand = () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

// ---------------------------------------------------------------------------
// computeMatterNameMap — deterministic across discovery-order permutations
// ---------------------------------------------------------------------------

const collisionSet = [
    { id: 'zone_18', type: 'zone', name: 'Finestra Studio' },
    { id: 'zone_19', type: 'zone', name: 'Finestra Cucina' },
    { id: 'cover_4', type: 'cover', name: 'Finestra Studio' },
    { id: 'cover_1', type: 'cover', name: 'Finestra Cucina' },
    { id: 'light_12', type: 'light', name: 'Studio' },
];

test('computeMatterNameMap: zones-first and covers-first orders produce the identical map', () => {
    const zonesFirst = computeMatterNameMap(collisionSet);
    const coversFirst = computeMatterNameMap([...collisionSet].reverse());
    assert.deepEqual(names(zonesFirst), names(coversFirst));
    // The controllable device always owns the clean voice name.
    assert.equal(zonesFirst.get('cover_4').name, 'Finestra Studio');
    assert.equal(zonesFirst.get('zone_18').name, 'Finestra Studio - Sens.');
    assert.equal(zonesFirst.get('cover_1').name, 'Finestra Cucina');
    assert.equal(zonesFirst.get('zone_19').name, 'Finestra Cucina - Sens.');
    assert.equal(zonesFirst.get('light_12').name, 'Studio');
});

test('computeMatterNameMap: any permutation converges to the same uuid -> name mapping', () => {
    const reference = names(computeMatterNameMap(collisionSet));
    for (let seed = 1; seed <= 25; seed++) {
        const permuted = names(computeMatterNameMap(shuffled(collisionSet, seed)));
        assert.deepEqual(permuted, reference, `permutation seed=${seed} diverged`);
    }
});

test('computeMatterNameMap: same-priority ties go to the lexicographically smaller uuid', () => {
    const twins = [
        { id: 'cover_9', type: 'cover', name: 'Finestra Bagno' },
        { id: 'cover_5', type: 'cover', name: 'Finestra Bagno' },
    ];
    for (const order of [twins, [...twins].reverse()]) {
        const map = computeMatterNameMap(order);
        assert.equal(map.get('cover_5').name, 'Finestra Bagno');
        assert.equal(map.get('cover_9').name, 'Finestra Bagno - Tapp.');
    }
});

test('computeMatterNameMap: names are unique case-insensitively', () => {
    const map = computeMatterNameMap([
        { id: 'zone_1', type: 'zone', name: 'finestra studio' },
        { id: 'cover_1', type: 'cover', name: 'Finestra Studio' },
    ]);
    assert.equal(map.get('cover_1').name, 'Finestra Studio');
    assert.notEqual(map.get('zone_1').name.toLowerCase(), 'finestra studio');
    assert.equal(findDuplicateDisplayNames(map.values()).length, 0);
});

test('computeMatterNameMap: uuid fallback tag is lengthened until unique', () => {
    // Both zones already mention their own type ("Sensore ..."), so the typed
    // suffix is skipped and the uuid fallback must disambiguate — even with
    // pathologically similar uuid tails.
    const map = computeMatterNameMap([
        { id: 'zone_a_777', type: 'zone', name: 'Sensore Porta' },
        { id: 'zone_b_777', type: 'zone', name: 'Sensore Porta' },
        { id: 'zone_c_777', type: 'zone', name: 'Sensore Porta' },
    ]);
    const finals = [...map.values()].map((e) => e.name.toLowerCase());
    assert.equal(new Set(finals).size, finals.length, `expected unique names, got ${finals}`);
});

test('findDuplicateDisplayNames: flags case-insensitive duplicates', () => {
    const dups = findDuplicateDisplayNames([
        { uuid: 'a', name: 'Finestra Bagno', base: 'Finestra Bagno' },
        { uuid: 'b', name: 'finestra bagno', base: 'finestra bagno' },
        { uuid: 'c', name: 'Altro', base: 'Altro' },
    ]);
    assert.equal(dups.length, 1);
    assert.deepEqual(dups[0].uuids.sort(), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// Real production dataset — 109 endpoints (fixture from klares4-devices.json)
// ---------------------------------------------------------------------------

const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'klares4-devices.json'), 'utf8'),
);

test('fixture sanity: 109 devices with the 6 documented cover/zone collisions', () => {
    assert.equal(fixture.devices.length, 109);
});

test('real 109-device dataset: no duplicate final names (case-insensitive)', () => {
    const map = computeMatterNameMap(fixture.devices);
    assert.equal(map.size, 109);
    assert.deepEqual(findDuplicateDisplayNames(map.values()), []);
    const lower = [...map.values()].map((e) => e.name.toLowerCase());
    assert.equal(new Set(lower).size, lower.length);
});

test('real 109-device dataset: voice-critical devices own their exact clean names', () => {
    const map = computeMatterNameMap(fixture.devices);
    // The three commands from the acceptance spec:
    assert.equal(map.get('light_12').name, 'Studio', '"accendi lo studio"');
    assert.equal(map.get('light_11').name, 'Lavanderia', '"accendi la lavanderia"');
    assert.equal(map.get('cover_6').name, 'Finestra Matrimoniale', '"chiudi finestra matrimoniale"');
});

test('real 109-device dataset: the 6 homonym zones take the " - Sens." suffix, covers stay clean', () => {
    const map = computeMatterNameMap(fixture.devices);
    const pairs = [
        ['cover_4', 'zone_18', 'Finestra Studio'],
        ['cover_1', 'zone_19', 'Finestra Cucina'],
        ['cover_5', 'zone_22', 'Finestra Bagno'],
        ['cover_6', 'zone_24', 'Finestra Matrimoniale'],
        ['cover_7', 'zone_25', 'Finestra Bagno Matrimoniale'],
        ['cover_8', 'zone_26', 'Finestra Cameretta'],
    ];
    for (const [coverId, zoneId, cleanName] of pairs) {
        assert.equal(map.get(coverId).name, cleanName, `${coverId} must own "${cleanName}"`);
        const zoneName = map.get(zoneId).name;
        assert.ok(zoneName.endsWith(' - Sens.'), `${zoneId} expected " - Sens." suffix, got "${zoneName}"`);
        assert.ok(zoneName.length <= 32, `${zoneId} name over 32 chars: "${zoneName}"`);
    }
});

test('real 109-device dataset: dirty panel labels are sanitised in the map', () => {
    const map = computeMatterNameMap(fixture.devices);
    assert.equal(map.get('cover_3').name, 'Balcone Sala', 'trailing space must be gone');
    assert.equal(map.get('scenario_15').name, 'Apri Mattina estate', 'parentheses stripped');
    assert.ok(!map.get('scenario_4').name.includes('+'), '"+" must be expanded');
});

test('real 109-device dataset: map is stable across 10 random discovery orders', () => {
    const reference = names(computeMatterNameMap(fixture.devices));
    for (let seed = 100; seed < 110; seed++) {
        const permuted = names(computeMatterNameMap(shuffled(fixture.devices, seed)));
        assert.deepEqual(permuted, reference, `fixture permutation seed=${seed} diverged`);
    }
});
