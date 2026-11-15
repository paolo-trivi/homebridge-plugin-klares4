const test = require('node:test');
const assert = require('node:assert/strict');

const {
    sanitizeMatterAccessoryName,
    MatterNameRegistry,
} = require('../dist/platform/matter-name-sanitizer.js');

// ---------------------------------------------------------------------------
// sanitizeMatterAccessoryName — allowlist & shaping
// ---------------------------------------------------------------------------

test('sanitizeMatterAccessoryName: trims trailing space', () => {
    assert.equal(sanitizeMatterAccessoryName('Balcone Veranda '), 'Balcone Veranda');
});

test('sanitizeMatterAccessoryName: replaces + with " e "', () => {
    assert.equal(
        sanitizeMatterAccessoryName('Inserisci Finestre+Tapparelle'),
        'Inserisci Finestre e Tapparelle',
    );
});

test('sanitizeMatterAccessoryName: removes parentheses but keeps content', () => {
    assert.equal(sanitizeMatterAccessoryName('Alza Tende (estate)'), 'Alza Tende estate');
});

test('sanitizeMatterAccessoryName: preserves typographic apostrophe', () => {
    assert.equal(sanitizeMatterAccessoryName('Chiudi l’ingresso'), 'Chiudi l’ingresso');
});

test('sanitizeMatterAccessoryName: preserves ASCII apostrophe', () => {
    assert.equal(sanitizeMatterAccessoryName("Chiudi l'ingresso"), "Chiudi l'ingresso");
});

test('sanitizeMatterAccessoryName: strips underscore', () => {
    assert.equal(sanitizeMatterAccessoryName('Zona_Notte'), 'Zona Notte');
});

test('sanitizeMatterAccessoryName: preserves accented Italian letters', () => {
    assert.equal(sanitizeMatterAccessoryName('Caffè è qui'), 'Caffè è qui');
});

test('sanitizeMatterAccessoryName: truncates names longer than 32 chars', () => {
    const long = 'A'.repeat(70);
    assert.equal(sanitizeMatterAccessoryName(long).length, 32);
});

test('sanitizeMatterAccessoryName: real-world "Inserisci Tapparelle+Volumetrici" stays <= 32', () => {
    const result = sanitizeMatterAccessoryName('Inserisci Tapparelle+Volumetrici');
    assert.ok(result.length <= 32, `length ${result.length}: "${result}"`);
});

test('sanitizeMatterAccessoryName: result satisfies HomeKit checkName regex', () => {
    const homekit = /^[\p{L}\p{N}][\p{L}\p{N}’ '.,\-]*[\p{L}\p{N}’]$/u;
    const samples = [
        'Balcone Veranda', 'Chiudi l’ingresso', 'Alza Tende estate',
        'Term. Veranda - Temp.', 'Inserisci Finestre e Tapparelle', 'Caffè',
    ];
    for (const s of samples) {
        const sanitized = sanitizeMatterAccessoryName(s);
        assert.ok(homekit.test(sanitized), `HAP rejected "${sanitized}" (from "${s}")`);
    }
});

test('sanitizeMatterAccessoryName: empty string → fallback', () => {
    assert.equal(sanitizeMatterAccessoryName('', 'Fallback'), 'Fallback');
    assert.equal(sanitizeMatterAccessoryName(''), 'Device');
});

// ---------------------------------------------------------------------------
// MatterNameRegistry — typed-suffix collision policy with priority
// ---------------------------------------------------------------------------

test('MatterNameRegistry: returns clean name when no collision', () => {
    const reg = new MatterNameRegistry();
    assert.equal(reg.resolve('cover_1', 'Balcone Veranda', 'cover'), 'Balcone Veranda');
});

test('MatterNameRegistry: same uuid revisiting gets the same clean name', () => {
    const reg = new MatterNameRegistry();
    assert.equal(reg.resolve('cover_1', 'Veranda', 'cover'), 'Veranda');
    assert.equal(reg.resolve('cover_1', 'Veranda', 'cover'), 'Veranda');
});

test('MatterNameRegistry: zone arrives before cover → cover displaces zone (priority)', () => {
    const reg = new MatterNameRegistry();
    const z = reg.resolve('zone_19', 'Finestra Taverna', 'zone');
    assert.equal(z, 'Finestra Taverna', 'first arrival takes the slot');

    const c = reg.resolve('cover_1', 'Finestra Taverna', 'cover');
    assert.equal(c, 'Finestra Taverna', 'higher-priority cover displaces the zone and keeps the clean name');

    const pending = reg.consumePendingRenames();
    assert.equal(pending.size, 1);
    assert.equal(pending.get('zone_19'), 'Finestra Taverna - Sens.', 'displaced zone gets typed abbreviation');
});

test('MatterNameRegistry: cover arrives before zone → zone gets the suffix immediately', () => {
    const reg = new MatterNameRegistry();
    const c = reg.resolve('cover_1', 'Finestra Taverna', 'cover');
    assert.equal(c, 'Finestra Taverna');

    const z = reg.resolve('zone_19', 'Finestra Taverna', 'zone');
    assert.equal(z, 'Finestra Taverna - Sens.');

    assert.equal(reg.consumePendingRenames().size, 0, 'no displacement when newcomer is lower priority');
});

test('MatterNameRegistry: typed abbreviations match the agreed table', () => {
    const reg = new MatterNameRegistry();
    reg.resolve('cover_a', 'Casa', 'cover');
    assert.equal(reg.resolve('zone_a', 'Casa', 'zone'), 'Casa - Sens.');

    const reg2 = new MatterNameRegistry();
    reg2.resolve('light_a', 'Casa', 'light');
    assert.equal(reg2.resolve('zone_b', 'Casa', 'zone'), 'Casa - Sens.');

    const reg3 = new MatterNameRegistry();
    reg3.resolve('cover_a', 'Test', 'cover');
    assert.equal(reg3.resolve('light_a', 'Test', 'light'), 'Test - Luce', 'same-priority: typed suffix on second');

    const reg4 = new MatterNameRegistry();
    reg4.resolve('cover_a', 'Test', 'cover');
    assert.equal(reg4.resolve('thermostat_a', 'Test', 'thermostat'), 'Test - Term.');

    const reg5 = new MatterNameRegistry();
    reg5.resolve('cover_a', 'Test', 'cover');
    assert.equal(reg5.resolve('gate_a', 'Test', 'gate'), 'Test - Cancello');
});

test('MatterNameRegistry: anti-redundancy — skip suffix when name already mentions own type', () => {
    const reg = new MatterNameRegistry();
    reg.resolve('cover_10', 'Tapparella Solaio', 'cover');
    const c2 = reg.resolve('cover_27', 'Tapparella Solaio', 'cover');
    // Same priority + name already says "Tapparella" → fallback uuid suffix
    assert.notEqual(c2, 'Tapparella Solaio - Tapp.');
    assert.ok(c2.endsWith('er27'), `device-id fallback expected, got "${c2}"`);
});

test('MatterNameRegistry: long name + suffix fits 32 chars with abbreviation', () => {
    const reg = new MatterNameRegistry();
    // "Finestra Atrio Foresteria" (27) + " - Sens." (8) = 35 → head gets truncated.
    reg.resolve('cover_7', 'Finestra Atrio Foresteria', 'cover');
    const z = reg.resolve('zone_25', 'Finestra Atrio Foresteria', 'zone');
    assert.ok(z.length <= 32, `length ${z.length}: "${z}"`);
    assert.ok(z.endsWith(' - Sens.'), `expected suffix tail in "${z}"`);
});

test('MatterNameRegistry: unknown deviceType falls back to uuid suffix on collision', () => {
    const reg = new MatterNameRegistry();
    reg.resolve('cover_a', 'Veranda', 'cover');
    const x = reg.resolve('uuid-bbbb', 'Veranda', 'mysterious');
    assert.ok(x.endsWith('bbbb'), `got "${x}"`);
});

test('MatterNameRegistry: deviceType omitted (legacy) → uuid fallback on collision', () => {
    const reg = new MatterNameRegistry();
    reg.resolve('uuid-aaaa', 'Veranda');
    const x = reg.resolve('uuid-bbbb', 'Veranda');
    assert.ok(x.endsWith('bbbb'));
});

test('MatterNameRegistry: device-id fallback is sanitized and unique', () => {
    const reg = new MatterNameRegistry();
    reg.resolve('cover_a-1234', 'Tapparella Solaio', 'cover');
    const second = reg.resolve('cover_b_1234', 'Tapparella Solaio', 'cover');
    const third = reg.resolve('cover-c_1234', 'Tapparella Solaio', 'cover');

    assert.doesNotMatch(second, /_/);
    assert.doesNotMatch(third, /_/);
    assert.notEqual(second.toLowerCase(), third.toLowerCase());
});

test('MatterNameRegistry: real-world Lares4 cover-vs-zone collisions (full ordering)', () => {
    const reg = new MatterNameRegistry();
    // Lares4 emits ZONES first, MULTI_TYPES (cover) second.
    const zones = [
        ['zone_18', 'Finestra Solaio'],
        ['zone_19', 'Finestra Taverna'],
        ['zone_22', 'Finestra Atrio'],
        ['zone_24', 'Finestra Foresteria'],
        ['zone_25', 'Finestra Atrio Foresteria'],
        ['zone_26', 'Finestra Mansarda'],
    ];
    for (const [uuid, name] of zones) {
        assert.equal(reg.resolve(uuid, name, 'zone'), name, `zone ${uuid} should take clean name first`);
    }
    const covers = [
        ['cover_1', 'Finestra Taverna'],
        ['cover_4', 'Finestra Solaio'],
        ['cover_5', 'Finestra Atrio'],
        ['cover_6', 'Finestra Foresteria'],
        ['cover_7', 'Finestra Atrio Foresteria'],
        ['cover_8', 'Finestra Mansarda'],
    ];
    for (const [uuid, name] of covers) {
        assert.equal(reg.resolve(uuid, name, 'cover'), name, `cover ${uuid} displaces and takes clean name`);
    }
    const renames = reg.consumePendingRenames();
    assert.equal(renames.size, 6);
    assert.equal(renames.get('zone_19'), 'Finestra Taverna - Sens.');
    assert.equal(renames.get('zone_22'), 'Finestra Atrio - Sens.');
    assert.equal(renames.get('zone_24'), 'Finestra Foresteria - Sens.');
    // Truncated: "Finestra Atrio Foresteria" (27) + " - Sens." (8) = 35 → head shortened.
    const tappBagnoMatri = renames.get('zone_25');
    assert.ok(tappBagnoMatri.endsWith(' - Sens.'));
    assert.ok(tappBagnoMatri.length <= 32);
});

test('MatterNameRegistry: consumePendingRenames returns and clears (idempotent)', () => {
    const reg = new MatterNameRegistry();
    reg.resolve('zone_1', 'Veranda', 'zone');
    reg.resolve('cover_1', 'Veranda', 'cover');
    assert.equal(reg.consumePendingRenames().size, 1);
    assert.equal(reg.consumePendingRenames().size, 0, 'second consume is empty');
});

test('MatterNameRegistry: re-resolving the displaced uuid clears its pending entry', () => {
    const reg = new MatterNameRegistry();
    reg.resolve('zone_1', 'Veranda', 'zone');
    reg.resolve('cover_1', 'Veranda', 'cover'); // displaces zone_1
    // Caller refreshes zone_1 by re-mapping. After this resolve, the pending
    // entry must be consumed (the name is now up-to-date in-band).
    const renamed = reg.resolve('zone_1', 'Veranda', 'zone');
    assert.equal(renamed, 'Veranda - Sens.');
    assert.equal(reg.consumePendingRenames().size, 0);
});

// ---------------------------------------------------------------------------
// MatterNameRegistry — deterministic resolution regardless of arrival order
// ---------------------------------------------------------------------------

function resolveAll(order) {
    const reg = new MatterNameRegistry();
    const results = new Map();
    for (const [uuid, name, type] of order) {
        results.set(uuid, reg.resolve(uuid, name, type));
    }
    // Apply pending displacement renames so the map reflects the final,
    // steady-state uuid -> displayName mapping (not transient first-call results).
    for (const [uuid, newName] of reg.consumePendingRenames()) {
        results.set(uuid, newName);
    }
    return results;
}

test('MatterNameRegistry: same-priority duplicate names resolve deterministically regardless of arrival order', () => {
    const devices = [
        ['cover_5', 'Finestra Atrio', 'cover'],
        ['cover_9', 'Finestra Atrio', 'cover'],
    ];

    const forward = resolveAll(devices);
    const reversed = resolveAll([...devices].reverse());

    // Smaller device.id always keeps the clean name, larger always gets the suffix —
    // independent of which one was discovered/resolved first.
    assert.equal(forward.get('cover_5'), 'Finestra Atrio');
    assert.equal(forward.get('cover_9'), 'Finestra Atrio - Tapp.');
    assert.deepEqual([...forward.entries()].sort(), [...reversed.entries()].sort(),
        'same input set resolved in a different order must converge to the same uuid -> displayName mapping');
});

test('MatterNameRegistry: three-way same-priority collision always gives the clean name to the smallest uuid, with no duplicate names', () => {
    const devices = [
        ['zone_30', 'Finestra Taverna', 'zone'],
        ['zone_12', 'Finestra Taverna', 'zone'],
        ['zone_5', 'Finestra Taverna', 'zone'],
    ];
    const permutations = [
        devices,
        [devices[1], devices[0], devices[2]],
        [devices[2], devices[1], devices[0]],
        [devices[2], devices[0], devices[1]],
    ];

    for (const order of permutations) {
        const mapping = resolveAll(order);
        // Lexicographically smallest uuid ("zone_12" < "zone_30" < "zone_5") must
        // always own the clean name, regardless of processing order.
        assert.equal(mapping.get('zone_12'), 'Finestra Taverna');
        // No two devices may ever end up sharing the exact same final displayName.
        const names = [...mapping.values()];
        assert.equal(new Set(names).size, names.length, `expected unique names, got ${JSON.stringify(names)}`);
    }
});

test('MatterNameRegistry: steady-state re-resolution produces no further pending renames', () => {
    const reg = new MatterNameRegistry();
    reg.resolve('cover_9', 'Finestra Atrio', 'cover');
    reg.resolve('cover_5', 'Finestra Atrio', 'cover'); // displaces cover_9 (smaller uuid wins)
    assert.equal(reg.consumePendingRenames().size, 1, 'first pass produces exactly one displacement rename');

    // Re-resolving the exact same set/order again is a steady state: no further churn.
    reg.resolve('cover_9', 'Finestra Atrio', 'cover');
    reg.resolve('cover_5', 'Finestra Atrio', 'cover');
    assert.equal(reg.consumePendingRenames().size, 0, 'steady-state re-resolution must not produce further renames');
});

test('MatterNameRegistry: collision detection is case-insensitive (voice namespace)', () => {
    const reg = new MatterNameRegistry();
    reg.resolve('cover_1', 'Finestra Solaio', 'cover');
    const z = reg.resolve('zone_2', 'finestra solaio', 'zone');
    assert.equal(z, 'finestra solaio - Sens.', 'case-different duplicate must be suffixed like the batch map');

    const reg2 = new MatterNameRegistry();
    reg2.seed('light_5', 'Solaio', 'Solaio', 'light');
    const other = reg2.resolve('zone_9', 'SOLAIO', 'zone');
    assert.notEqual(other.toLowerCase(), 'solaio', 'seeded slot must be honoured case-insensitively');
});
