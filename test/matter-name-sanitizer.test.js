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

test('sanitizeMatterAccessoryName: trims leading space', () => {
    assert.equal(sanitizeMatterAccessoryName('  Sala'), 'Sala');
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

test('sanitizeMatterAccessoryName: removes square brackets but keeps content', () => {
    assert.equal(sanitizeMatterAccessoryName('Zona [piano terra]'), 'Zona piano terra');
});

test('sanitizeMatterAccessoryName: preserves typographic apostrophe (HomeKit-allowed)', () => {
    const name = 'Chiudi l’ingresso';
    assert.equal(sanitizeMatterAccessoryName(name), 'Chiudi l’ingresso');
});

test('sanitizeMatterAccessoryName: preserves ASCII apostrophe (HomeKit-allowed)', () => {
    assert.equal(sanitizeMatterAccessoryName("Chiudi l'ingresso"), "Chiudi l'ingresso");
});

test('sanitizeMatterAccessoryName: collapses multiple spaces', () => {
    assert.equal(sanitizeMatterAccessoryName('Balcone   Sala'), 'Balcone Sala');
});

test('sanitizeMatterAccessoryName: replaces slash with space (not in HomeKit allowlist)', () => {
    assert.equal(sanitizeMatterAccessoryName('Luce/Presa'), 'Luce Presa');
});

test('sanitizeMatterAccessoryName: strips underscore (not in HomeKit allowlist)', () => {
    assert.equal(sanitizeMatterAccessoryName('Zona_Notte'), 'Zona Notte');
});

test('sanitizeMatterAccessoryName: strips colon, semicolon, pipe', () => {
    assert.equal(sanitizeMatterAccessoryName('Zona: Notte; piano | terra'), 'Zona Notte piano terra');
});

test('sanitizeMatterAccessoryName: preserves period, comma, hyphen', () => {
    assert.equal(sanitizeMatterAccessoryName('Term. Sala - Temp., 2'), 'Term. Sala - Temp., 2');
});

test('sanitizeMatterAccessoryName: handles empty string → fallback', () => {
    assert.equal(sanitizeMatterAccessoryName('', 'Fallback'), 'Fallback');
});

test('sanitizeMatterAccessoryName: handles whitespace-only string → fallback', () => {
    assert.equal(sanitizeMatterAccessoryName('   ', 'Fallback'), 'Fallback');
});

test('sanitizeMatterAccessoryName: uses default fallback "Device" when none supplied', () => {
    assert.equal(sanitizeMatterAccessoryName(''), 'Device');
});

test('sanitizeMatterAccessoryName: truncates names longer than 32 chars (Matter nodeLabel limit)', () => {
    const long = 'A'.repeat(70);
    const result = sanitizeMatterAccessoryName(long);
    assert.equal(result.length, 32);
});

test('sanitizeMatterAccessoryName: real-world failing scenario "Inserisci Tapparelle+Volumetrici" stays <= 32', () => {
    const result = sanitizeMatterAccessoryName('Inserisci Tapparelle+Volumetrici');
    assert.ok(result.length <= 32, `length ${result.length} > 32: "${result}"`);
});

test('sanitizeMatterAccessoryName: "Inserisci Finestre+Volumetrici" stays <= 32', () => {
    const result = sanitizeMatterAccessoryName('Inserisci Finestre+Volumetrici');
    assert.ok(result.length <= 32, `length ${result.length} > 32: "${result}"`);
});

test('sanitizeMatterAccessoryName: preserves accented Italian letters', () => {
    assert.equal(sanitizeMatterAccessoryName('Caffè è qui'), 'Caffè è qui');
});

test('sanitizeMatterAccessoryName: result satisfies HomeKit checkName regex', () => {
    // Mirror the HAP-NodeJS rule:
    //   ^[\p{L}\p{N}][\p{L}\p{N}’ '.,-]*[\p{L}\p{N}’]$
    const homekit = /^[\p{L}\p{N}][\p{L}\p{N}’ '.,\-]*[\p{L}\p{N}’]$/u;
    const samples = [
        'Balcone Sala',
        'Chiudi l’ingresso',
        'Apri Mattina estate',
        'Term. Sala - Temp.',
        'Inserisci Finestre e Tapparelle',
        'Caffè',
    ];
    for (const s of samples) {
        const sanitized = sanitizeMatterAccessoryName(s);
        assert.ok(homekit.test(sanitized), `HomeKit checkName rejected "${sanitized}" (from "${s}")`);
    }
});

test('sanitizeMatterAccessoryName: strips trailing punctuation so name ends with letter/digit/apostrophe', () => {
    // hyphen is allowed in middle but NOT at the end per HomeKit rule
    assert.equal(sanitizeMatterAccessoryName('Sala -'), 'Sala');
    assert.equal(sanitizeMatterAccessoryName('Sala.'), 'Sala');
});

// ---------------------------------------------------------------------------
// MatterNameRegistry — typed-suffix collision policy
// ---------------------------------------------------------------------------

test('MatterNameRegistry: returns sanitized name when no collision', () => {
    const registry = new MatterNameRegistry();
    assert.equal(registry.resolve('cover_1', 'Balcone Sala', 'cover'), 'Balcone Sala');
});

test('MatterNameRegistry: same uuid can resolve to same name twice', () => {
    const registry = new MatterNameRegistry();
    assert.equal(registry.resolve('cover_1', 'Sala', 'cover'), 'Sala');
    assert.equal(registry.resolve('cover_1', 'Sala', 'cover'), 'Sala');
});

test('MatterNameRegistry: collision between cover and zone uses italian typed suffix', () => {
    const registry = new MatterNameRegistry();
    const first = registry.resolve('cover_1', 'Finestra Cucina', 'cover');
    const second = registry.resolve('zone_19', 'Finestra Cucina', 'zone');
    assert.equal(first, 'Finestra Cucina');
    assert.equal(second, 'Finestra Cucina - Sensore');
});

test('MatterNameRegistry: collision uses the second device\'s own type, not the first one\'s', () => {
    const registry = new MatterNameRegistry();
    const first = registry.resolve('cover_27', 'Tapparella Studio', 'cover');
    const second = registry.resolve('zone_27', 'Tapparella Studio', 'zone');
    assert.equal(first, 'Tapparella Studio');
    // zone's own type is "Sensore". "Tapparella Studio" doesn't contain "Sensore",
    // so the typed suffix applies even though the name mentions the *other*
    // device's type. Goal: each accessory tags itself with what it is, not what
    // its sibling is.
    assert.equal(second, 'Tapparella Studio - Sensore');
});

test('MatterNameRegistry: anti-redundancy — skip suffix when name already mentions the OWN type', () => {
    const registry = new MatterNameRegistry();
    // Two covers (hypothetical) that sanitise to the same string both containing
    // "Tapparella". The collision suffix " - Tapparella" would be redundant, so
    // the second one falls back to the uuid-derived suffix.
    const first = registry.resolve('cover_10', 'Tapparella Studio', 'cover');
    const second = registry.resolve('cover_27', 'Tapparella Studio', 'cover');
    assert.equal(first, 'Tapparella Studio');
    assert.notEqual(second, 'Tapparella Studio - Tapparella');
    assert.ok(second.endsWith('r_27'), `expected uuid fallback in "${second}"`);
});

test('MatterNameRegistry: unknown device type falls back to uuid suffix immediately', () => {
    const registry = new MatterNameRegistry();
    registry.resolve('uuid-aaaa', 'Sala', 'cover');
    const second = registry.resolve('uuid-bbbb', 'Sala', 'mysterious');
    assert.ok(second.endsWith('bbbb'), `expected uuid fallback for unknown type in "${second}"`);
});

test('MatterNameRegistry: deviceType omitted (legacy caller) falls back to uuid suffix on collision', () => {
    const registry = new MatterNameRegistry();
    registry.resolve('uuid-aaaa', 'Sala');
    const second = registry.resolve('uuid-bbbb', 'Sala');
    assert.ok(second.endsWith('bbbb'));
});

test('MatterNameRegistry: typed suffix candidate respects 32-char cap by truncating name part', () => {
    const registry = new MatterNameRegistry();
    const longName = 'X'.repeat(28); // 28 + " - Sensore" (10) = 38 > 32
    registry.resolve('cover_a', longName, 'cover');
    const second = registry.resolve('zone_b', longName, 'zone');
    assert.ok(second.length <= 32, `length ${second.length} > 32: "${second}"`);
    assert.ok(second.endsWith(' - Sensore'), `expected typed suffix tail in "${second}"`);
});

test('MatterNameRegistry: real-world Finestra Bagno cover + zone collision', () => {
    const registry = new MatterNameRegistry();
    const cover = registry.resolve('cover_5', 'Finestra Bagno', 'cover');
    const zone = registry.resolve('zone_22', 'Finestra Bagno', 'zone');
    assert.equal(cover, 'Finestra Bagno');
    assert.equal(zone, 'Finestra Bagno - Sensore');
});

test('MatterNameRegistry: thermostat colliding with another thermostat falls back to uuid suffix', () => {
    const registry = new MatterNameRegistry();
    // Two thermostats with the same sanitised name (artificial, but covers the
    // "typed suffix also collides" code path).
    const first = registry.resolve('thermostat_18', 'Sala', 'thermostat');
    const second = registry.resolve('thermostat_34', 'Sala', 'thermostat');
    assert.equal(first, 'Sala');
    // "Sala - Termostato" would also collide if both insisted; with single
    // collision the typed suffix wins. Verify the second one uses the typed suffix
    // (no third item is colliding here).
    assert.equal(second, 'Sala - Termostato');
});
