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
    assert.equal(sanitizeMatterAccessoryName('Balcone Sala '), 'Balcone Sala');
});

test('sanitizeMatterAccessoryName: replaces + with " e "', () => {
    assert.equal(
        sanitizeMatterAccessoryName('Inserisci Finestre+Tapparelle'),
        'Inserisci Finestre e Tapparelle',
    );
});

test('sanitizeMatterAccessoryName: removes parentheses but keeps content', () => {
    assert.equal(sanitizeMatterAccessoryName('Apri Mattina (estate)'), 'Apri Mattina estate');
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
        'Balcone Sala', 'Chiudi l’ingresso', 'Apri Mattina estate',
        'Term. Sala - Temp.', 'Inserisci Finestre e Tapparelle', 'Caffè',
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
    assert.equal(reg.resolve('cover_1', 'Balcone Sala', 'cover'), 'Balcone Sala');
});

test('MatterNameRegistry: same uuid revisiting gets the same clean name', () => {
    const reg = new MatterNameRegistry();
    assert.equal(reg.resolve('cover_1', 'Sala', 'cover'), 'Sala');
    assert.equal(reg.resolve('cover_1', 'Sala', 'cover'), 'Sala');
});

test('MatterNameRegistry: zone arrives before cover → cover displaces zone (priority)', () => {
    const reg = new MatterNameRegistry();
    const z = reg.resolve('zone_19', 'Finestra Cucina', 'zone');
    assert.equal(z, 'Finestra Cucina', 'first arrival takes the slot');

    const c = reg.resolve('cover_1', 'Finestra Cucina', 'cover');
    assert.equal(c, 'Finestra Cucina', 'higher-priority cover displaces the zone and keeps the clean name');

    const pending = reg.consumePendingRenames();
    assert.equal(pending.size, 1);
    assert.equal(pending.get('zone_19'), 'Finestra Cucina - Sens.', 'displaced zone gets typed abbreviation');
});

test('MatterNameRegistry: cover arrives before zone → zone gets the suffix immediately', () => {
    const reg = new MatterNameRegistry();
    const c = reg.resolve('cover_1', 'Finestra Cucina', 'cover');
    assert.equal(c, 'Finestra Cucina');

    const z = reg.resolve('zone_19', 'Finestra Cucina', 'zone');
    assert.equal(z, 'Finestra Cucina - Sens.');

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
    reg.resolve('cover_10', 'Tapparella Studio', 'cover');
    const c2 = reg.resolve('cover_27', 'Tapparella Studio', 'cover');
    // Same priority + name already says "Tapparella" → fallback uuid suffix
    assert.notEqual(c2, 'Tapparella Studio - Tapp.');
    assert.ok(c2.endsWith('r_27'), `uuid fallback expected, got "${c2}"`);
});

test('MatterNameRegistry: long name + suffix fits 32 chars with abbreviation', () => {
    const reg = new MatterNameRegistry();
    // "Finestra Bagno Matrimoniale" (27) + " - Sens." (8) = 35 → head gets truncated.
    reg.resolve('cover_7', 'Finestra Bagno Matrimoniale', 'cover');
    const z = reg.resolve('zone_25', 'Finestra Bagno Matrimoniale', 'zone');
    assert.ok(z.length <= 32, `length ${z.length}: "${z}"`);
    assert.ok(z.endsWith(' - Sens.'), `expected suffix tail in "${z}"`);
});

test('MatterNameRegistry: unknown deviceType falls back to uuid suffix on collision', () => {
    const reg = new MatterNameRegistry();
    reg.resolve('cover_a', 'Sala', 'cover');
    const x = reg.resolve('uuid-bbbb', 'Sala', 'mysterious');
    assert.ok(x.endsWith('bbbb'), `got "${x}"`);
});

test('MatterNameRegistry: deviceType omitted (legacy) → uuid fallback on collision', () => {
    const reg = new MatterNameRegistry();
    reg.resolve('uuid-aaaa', 'Sala');
    const x = reg.resolve('uuid-bbbb', 'Sala');
    assert.ok(x.endsWith('bbbb'));
});

test('MatterNameRegistry: real-world Lares4 cover-vs-zone collisions (full ordering)', () => {
    const reg = new MatterNameRegistry();
    // Lares4 emits ZONES first, MULTI_TYPES (cover) second.
    const zones = [
        ['zone_18', 'Finestra Studio'],
        ['zone_19', 'Finestra Cucina'],
        ['zone_22', 'Finestra Bagno'],
        ['zone_24', 'Finestra Matrimoniale'],
        ['zone_25', 'Finestra Bagno Matrimoniale'],
        ['zone_26', 'Finestra Cameretta'],
    ];
    for (const [uuid, name] of zones) {
        assert.equal(reg.resolve(uuid, name, 'zone'), name, `zone ${uuid} should take clean name first`);
    }
    const covers = [
        ['cover_1', 'Finestra Cucina'],
        ['cover_4', 'Finestra Studio'],
        ['cover_5', 'Finestra Bagno'],
        ['cover_6', 'Finestra Matrimoniale'],
        ['cover_7', 'Finestra Bagno Matrimoniale'],
        ['cover_8', 'Finestra Cameretta'],
    ];
    for (const [uuid, name] of covers) {
        assert.equal(reg.resolve(uuid, name, 'cover'), name, `cover ${uuid} displaces and takes clean name`);
    }
    const renames = reg.consumePendingRenames();
    assert.equal(renames.size, 6);
    assert.equal(renames.get('zone_19'), 'Finestra Cucina - Sens.');
    assert.equal(renames.get('zone_22'), 'Finestra Bagno - Sens.');
    assert.equal(renames.get('zone_24'), 'Finestra Matrimoniale - Sens.');
    // Truncated: "Finestra Bagno Matrimoniale" (27) + " - Sens." (8) = 35 → head shortened.
    const tappBagnoMatri = renames.get('zone_25');
    assert.ok(tappBagnoMatri.endsWith(' - Sens.'));
    assert.ok(tappBagnoMatri.length <= 32);
});

test('MatterNameRegistry: consumePendingRenames returns and clears (idempotent)', () => {
    const reg = new MatterNameRegistry();
    reg.resolve('zone_1', 'Sala', 'zone');
    reg.resolve('cover_1', 'Sala', 'cover');
    assert.equal(reg.consumePendingRenames().size, 1);
    assert.equal(reg.consumePendingRenames().size, 0, 'second consume is empty');
});

test('MatterNameRegistry: re-resolving the displaced uuid clears its pending entry', () => {
    const reg = new MatterNameRegistry();
    reg.resolve('zone_1', 'Sala', 'zone');
    reg.resolve('cover_1', 'Sala', 'cover'); // displaces zone_1
    // Caller refreshes zone_1 by re-mapping. After this resolve, the pending
    // entry must be consumed (the name is now up-to-date in-band).
    const renamed = reg.resolve('zone_1', 'Sala', 'zone');
    assert.equal(renamed, 'Sala - Sens.');
    assert.equal(reg.consumePendingRenames().size, 0);
});
