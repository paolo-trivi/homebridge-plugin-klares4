'use strict';

// MAT-12: the Matter name limit is counted as Homebridge and matter.js count
// it (UTF-16 code units), never splits a character, and cleaning a hostile
// name takes linear time. MAT-16: the voice analysis normalizes each name once.

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeMatterAccessoryName, isValidMatterAccessoryName, buildTypedSuffix } = require('../dist/platform/matter-name-sanitizer.js');
const { sanitizeHapDisplayName } = require('../dist/display-name.js');
const { computeMatterNameMap } = require('../dist/platform/matter-name-map.js');
const { analyzeMatterVoiceCollisions } = require('../dist/platform/matter-voice-analyzer.js');
const { deviceToMatterAccessory } = require('../dist/platform/matter-device-mapper.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');

const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });
// U+20000 (CJK Extension B): a letter (\p{L}) outside the BMP that NFKC leaves
// alone; two UTF-16 units per character.
const ASTRAL = '\u{20000}';

const isWellFormed = (s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

test('MAT-12: names with letters outside the BMP fit in 32 UTF-16 units without a split character', () => {
    for (const raw of [ASTRAL.repeat(32), `a${ASTRAL.repeat(31)}`, `Sala ${ASTRAL.repeat(20)} est`]) {
        const name = sanitizeMatterAccessoryName(raw, 'zone_1');
        assert.ok(name.length <= 32, `${name.length} units`);
        assert.ok(isWellFormed(name), 'no lone surrogate');
        assert.ok(isValidMatterAccessoryName(name));
    }
    assert.equal(isValidMatterAccessoryName(ASTRAL.repeat(17)), false, '34 units is over the limit');
    const typed = buildTypedSuffix(ASTRAL.repeat(16), 'zone');
    assert.ok(typed.length <= 32 && isWellFormed(typed) && typed.endsWith(' - Sens.'));
});

test('MAT-12: a name the map believes unique is the label Homebridge shows', { timeout: 120000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const devices = [
        { id: 'zone_1', type: 'zone', name: ASTRAL.repeat(40), description: '', status: { open: false } },
        { id: 'zone_2', type: 'zone', name: `${ASTRAL.repeat(16)}x`, description: '', status: { open: false } },
    ];
    const entries = computeMatterNameMap(devices);
    const names = [...entries.values()].map((e) => e.name);
    assert.equal(new Set(names).size, 2);
    for (const device of devices) {
        const accessory = deviceToMatterAccessory(device, {
            api: stack.api, log: silentLog(), getWsClient: () => undefined, resolveDisplayName: (d) => entries.get(d.id).name,
        });
        await stack.register([accessory]);
        assert.equal(stack.read(device.id, 'bridgedDeviceBasicInformation').nodeLabel, entries.get(device.id).name);
    }
    assert.deepEqual(stack.hbLines.filter((l) => /longer than the 32 characters/.test(l)), []);
});

test('MAT-12: cleaning a long run of separators takes linear time', () => {
    const time = (n) => {
        const raw = `a${'.'.repeat(n)}a`;
        const start = process.hrtime.bigint();
        sanitizeMatterAccessoryName(raw, 'zone_1');
        sanitizeHapDisplayName(raw, 'zone_1');
        return Number(process.hrtime.bigint() - start) / 1e6;
    };
    time(1000);
    // 2.2.0 was quadratic: ~390 ms at 20 000 separators, ~6 s at 80 000, so
    // ~25 s at 160 000. Linear work takes a few tens of ms; the budget leaves
    // room for a loaded CI machine and still catches the quadratic case.
    assert.ok(time(160000) < 3000, 'sanitizing 160 000 separators must not block the event loop');
    assert.equal(sanitizeMatterAccessoryName(`Luce${'.'.repeat(5000)}`, 'light_1'), 'Luce');
    assert.equal(sanitizeHapDisplayName(`Luce${' -'.repeat(5000)}`, 'light_1'), 'Luce');
});

test('MAT-12: ordinary names are cleaned exactly as before', () => {
    assert.equal(sanitizeMatterAccessoryName('Luce (ingresso) + scale', 'light_1'), 'Luce ingresso e scale');
    assert.equal(sanitizeMatterAccessoryName('Camera dei bambini con finestra grande', 'zone_1'), 'Camera dei bambini con finestra');
    assert.equal(sanitizeHapDisplayName('A', 'zone 3'), 'A zone 3');
    assert.equal(sanitizeMatterAccessoryName('Città’', 'zone_2'), 'Città’');
    assert.equal(sanitizeHapDisplayName('Città’', 'zone_2'), 'Città');
});

test('MAT-16: the voice analysis normalizes each name a bounded number of times', () => {
    const devices = [];
    for (let n = 0; n < 150; n += 1) devices.push({ id: `zone_${n}`, type: 'zone', name: `Finestra ${n % 10} lato ${n}` });
    const entries = computeMatterNameMap(devices);
    const original = String.prototype.normalize;
    let calls = 0;
    String.prototype.normalize = function countingNormalize(...args) { calls += 1; return original.apply(this, args); };
    let result;
    try {
        result = analyzeMatterVoiceCollisions(devices, entries);
    } finally {
        String.prototype.normalize = original;
    }
    // 2.2.0 normalized both names for each of the 11 175 pairs.
    assert.ok(calls < devices.length * 10, `${calls} normalize calls for ${devices.length} devices`);
    assert.equal(result.findings.length > 0, true);
});
