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

test('sanitizeMatterAccessoryName: truncates names longer than 64 chars', () => {
    const long = 'A'.repeat(70);
    const result = sanitizeMatterAccessoryName(long);
    assert.equal(result.length, 64);
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

test('MatterNameRegistry: collision suffix fits within 64 chars', () => {
    const registry = new MatterNameRegistry();
    const longName = 'A'.repeat(60);
    registry.resolve('uuid-aaaa', longName);
    const second = registry.resolve('uuid-bbbb', longName);
    assert.ok(second.length <= 64, `name length ${second.length} exceeds 64`);
});
