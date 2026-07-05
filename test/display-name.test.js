const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeHapDisplayName, cleanDisplayName, HAP_MAX_NAME_LENGTH } = require('../dist/display-name.js');

// HAP-NodeJS checkName rule.
const HAP_CHECK_NAME = /^[\p{L}\p{N}][\p{L}\p{N}’ '.,\-]*[\p{L}\p{N}’]$/u;

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
