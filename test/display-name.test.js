const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeHapDisplayName, cleanDisplayName, HAP_MAX_NAME_LENGTH } = require('../dist/display-name.js');
const { sanitizeMatterAccessoryName } = require('../dist/platform/matter-name-sanitizer.js');

// HAP-NodeJS 2.2.2 checkName rule (util/checkName.js): starts AND ends with a
// letter or digit, so at least two characters and no trailing apostrophe.
const HAP_CHECK_NAME = /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}\u2019'&!._:;()/,-]*[\p{L}\p{N}]$/u;

test('sanitizeHapDisplayName: production offenders satisfy the HAP checkName regex', () => {
    const offenders = [
        'Balcone Sala ',
        'Inserisci Finestre+Tapparelle',
        'Inserisci Tapparelle+Volumetrici',
        'Inserisci Finestre+Volumetrici',
        'Apri Mattina (estate)',
        'Apri Pomeriggio (estate)',
    ];
    for (const raw of offenders) {
        const clean = sanitizeHapDisplayName(raw);
        assert.ok(HAP_CHECK_NAME.test(clean), `checkName rejected "${clean}" (from "${raw}")`);
    }
});

test('sanitizeHapDisplayName: same word-level transformations as the Matter sanitiser', () => {
    assert.equal(sanitizeHapDisplayName('Balcone Sala '), 'Balcone Sala');
    assert.equal(sanitizeHapDisplayName('Inserisci Finestre+Tapparelle'), 'Inserisci Finestre e Tapparelle');
    assert.equal(sanitizeHapDisplayName('Apri Mattina (estate)'), 'Apri Mattina estate');
    assert.equal(sanitizeHapDisplayName("Chiudi l'ingresso"), "Chiudi l'ingresso");
    assert.equal(sanitizeHapDisplayName('Caffè è qui'), 'Caffè è qui');
});

test('sanitizeHapDisplayName: HAP budget is 64 chars (not the Matter 32)', () => {
    const long = 'Inserisci Tapparelle e Volumetrici del Piano Terra e del Primo Piano';
    const clean = sanitizeHapDisplayName(long);
    assert.ok(clean.length <= HAP_MAX_NAME_LENGTH);
    assert.ok(clean.length > 32, 'HAP names must not be truncated to the Matter limit');
});

test('sanitizeHapDisplayName: empty input falls back', () => {
    assert.equal(sanitizeHapDisplayName('', 'zone_12'), 'zone 12');
    assert.equal(sanitizeHapDisplayName('***'), 'Device');
});

test('cleanDisplayName: returns empty string when nothing survives (callers decide the fallback)', () => {
    assert.equal(cleanDisplayName('()[]+', 32), 'e');
    assert.equal(cleanDisplayName('___', 32), '');
});

test('cleanDisplayName: normalizes decomposed Unicode before applying the allowlist', () => {
    assert.equal(cleanDisplayName('Caffe\u0300', 32), 'Caffè');
});

test('sanitizeHapDisplayName: names ending in an apostrophe satisfy the HAP-NodeJS 2.2.2 rule', () => {
    assert.equal(sanitizeHapDisplayName('Luce po’', 'light_4'), 'Luce po');
    assert.equal(sanitizeHapDisplayName("Luce po'", 'light_4'), 'Luce po');
    assert.equal(sanitizeHapDisplayName('’A’ B’', 'light_4'), 'A’ B');
    for (const raw of ['Luce po’', '’A’', 'Tapparella d’', 'x’’']) {
        const clean = sanitizeHapDisplayName(raw, 'cover_2');
        assert.ok(HAP_CHECK_NAME.test(clean), `checkName rejected "${clean}" (from "${raw}")`);
    }
});

test('sanitizeHapDisplayName: one-character names get the device id appended', () => {
    assert.equal(sanitizeHapDisplayName('A', 'zone_3'), 'A zone 3');
    assert.equal(sanitizeHapDisplayName('7', 'light_7'), '7 light 7');
    assert.equal(sanitizeHapDisplayName('x-', 'zone_3'), 'x zone 3');
    assert.equal(sanitizeHapDisplayName('’A’', 'zone_3'), 'A zone 3');
    assert.equal(sanitizeHapDisplayName('***', 'z'), 'Device');
    for (const raw of ['A', '7', 'x-', '’A’', '', '***']) {
        const clean = sanitizeHapDisplayName(raw, 'zone_3');
        assert.ok(HAP_CHECK_NAME.test(clean), `checkName rejected "${clean}" (from "${raw}")`);
    }
});

test('HAP-only name rules leave Matter names byte-for-byte unchanged', () => {
    // Paired Matter endpoints and the persisted name map depend on these values.
    const expected = {
        'Luce po’': 'Luce po’',
        "Luce po'": 'Luce po',
        A: 'A',
        7: '7',
        '’A’': 'A’',
        'x-': 'x',
        'Balcone Sala ': 'Balcone Sala',
        'Apri Mattina (estate)': 'Apri Mattina estate',
        'Inserisci Finestre+Tapparelle': 'Inserisci Finestre e Tapparelle',
    };
    for (const [raw, name] of Object.entries(expected)) {
        assert.equal(sanitizeMatterAccessoryName(raw), name, `Matter name changed for "${raw}"`);
    }
    assert.equal(cleanDisplayName('Luce po’', 32), 'Luce po’');
    assert.equal(cleanDisplayName('A', 32), 'A');
});

test('sanitizeHapDisplayName: the real HAP-NodeJS checkName accepts every sanitised name', (t) => {
    const { checkName } = require('@homebridge/hap-nodejs/dist/lib/util/checkName.js');
    const warnings = [];
    t.mock.method(console, 'warn', (message) => { warnings.push(message); });
    for (const raw of ['Luce po’', "Luce po'", 'A', '7', 'x-', '’A’', '', '***', 'Balcone Sala ', 'Apri Mattina (estate)']) {
        checkName('test', 'Name', sanitizeHapDisplayName(raw, 'zone_3'));
    }
    assert.deepEqual(warnings, []);
});
