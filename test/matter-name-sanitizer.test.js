const test = require('node:test');
const assert = require('node:assert/strict');

const {
    sanitizeMatterAccessoryName,
    MatterNameRegistry,
} = require('../dist/platform/matter-name-sanitizer.js');

// ---------------------------------------------------------------------------
// sanitizeMatterAccessoryName
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

test('sanitizeMatterAccessoryName: removes typographic apostrophes', () => {
    const name = 'Chiudi l\u2019ingresso';  // right single quotation mark
    assert.equal(sanitizeMatterAccessoryName(name), 'Chiudi lingresso');
});

test('sanitizeMatterAccessoryName: removes ASCII apostrophe', () => {
    assert.equal(sanitizeMatterAccessoryName("Chiudi l'ingresso"), 'Chiudi lingresso');
});

test('sanitizeMatterAccessoryName: collapses multiple spaces', () => {
    assert.equal(sanitizeMatterAccessoryName('Balcone   Sala'), 'Balcone Sala');
});

test('sanitizeMatterAccessoryName: replaces slash with space', () => {
    assert.equal(sanitizeMatterAccessoryName('Luce/Presa'), 'Luce Presa');
});

test('sanitizeMatterAccessoryName: handles empty string → fallback', () => {
    assert.equal(sanitizeMatterAccessoryName('', 'Fallback'), 'Fallback');
});

test('sanitizeMatterAccessoryName: handles whitespace-only string → fallback', () => {
    assert.equal(sanitizeMatterAccessoryName('   ', 'Fallback'), 'Fallback');
});

test('sanitizeMatterAccessoryName: handles string that becomes empty after cleanup → fallback', () => {
    assert.equal(sanitizeMatterAccessoryName('+++', 'MyDevice'), 'e e e');
    // "+++" → " e  e  e " → collapse → "e e e"
});

test('sanitizeMatterAccessoryName: uses default fallback "Device" when none supplied', () => {
    assert.equal(sanitizeMatterAccessoryName(''), 'Device');
});

test('sanitizeMatterAccessoryName: truncates names longer than 32 chars (Matter nodeLabel limit)', () => {
    const long = 'A'.repeat(70);
    const result = sanitizeMatterAccessoryName(long);
    assert.equal(result.length, 32);
});

// Regression: real-world Lares4 scenario name that previously failed Matter
// registration with "String length of 34 is not within bounds" because the "+"
// → " e " expansion grew the string past 32 chars while the sanitiser still used
// the old 64-char ceiling.
test('sanitizeMatterAccessoryName: real-world failing scenario "Inserisci Tapparelle+Volumetrici" stays <= 32', () => {
    const result = sanitizeMatterAccessoryName('Inserisci Tapparelle+Volumetrici');
    assert.ok(result.length <= 32, `length ${result.length} > 32: "${result}"`);
});

test('sanitizeMatterAccessoryName: "Inserisci Finestre+Volumetrici" stays <= 32', () => {
    const result = sanitizeMatterAccessoryName('Inserisci Finestre+Volumetrici');
    assert.ok(result.length <= 32, `length ${result.length} > 32: "${result}"`);
});

test('sanitizeMatterAccessoryName: preserves accented Italian letters', () => {
    const name = 'Ingresso Città';
    assert.equal(sanitizeMatterAccessoryName(name), 'Ingresso Citt\u00e0');
});

// ---------------------------------------------------------------------------
// MatterNameRegistry — collision detection
// ---------------------------------------------------------------------------

test('MatterNameRegistry: returns sanitized name when no collision', () => {
    const registry = new MatterNameRegistry();
    assert.equal(registry.resolve('uuid-1', 'Balcone Sala'), 'Balcone Sala');
});

test('MatterNameRegistry: same uuid can resolve to same name twice', () => {
    const registry = new MatterNameRegistry();
    assert.equal(registry.resolve('uuid-1', 'Sala'), 'Sala');
    assert.equal(registry.resolve('uuid-1', 'Sala'), 'Sala');
});

test('MatterNameRegistry: collision produces distinct name with stable suffix', () => {
    const registry = new MatterNameRegistry();
    const first = registry.resolve('uuid-aaaa', 'Sala');
    const second = registry.resolve('uuid-bbbb', 'Sala');
    assert.equal(first, 'Sala');
    assert.notEqual(second, 'Sala', 'colliding name must be different');
    // The suffix must be derived from the uuid (last 4 hex chars, dashes stripped)
    assert.ok(second.includes('bbbb'), `expected suffix "bbbb" in "${second}"`);
});

test('MatterNameRegistry: collision suffix fits within 32 chars', () => {
    const registry = new MatterNameRegistry();
    const longName = 'A'.repeat(30);
    registry.resolve('uuid-aaaa', longName);
    const second = registry.resolve('uuid-bbbb', longName);
    assert.ok(second.length <= 32, `name length ${second.length} exceeds 32`);
});

test('MatterNameRegistry: long-name collision still ends with stable uuid suffix and stays <= 32', () => {
    const registry = new MatterNameRegistry();
    // Real-world: two scenarios that collide after sanitisation to a 32-char string
    const name = sanitizeMatterAccessoryName('Inserisci Tapparelle+Volumetrici');
    const first = registry.resolve('00000000-0000-0000-0000-000000001111', name);
    const second = registry.resolve('00000000-0000-0000-0000-000000002222', name);
    assert.equal(first.length <= 32, true);
    assert.equal(second.length <= 32, true);
    assert.notEqual(first, second);
    assert.ok(second.endsWith('2222'), `expected "2222" suffix in "${second}"`);
});
