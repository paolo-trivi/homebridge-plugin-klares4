'use strict';

// PLAT-10, MAT-09, MAT-10: the legacy map forms are validated like the arrays,
// duplicate override rows are merged, lookups never reach the prototype, and
// override rows that match no device are reported.

const test = require('node:test');
const assert = require('node:assert/strict');

const { DiscoveryService } = require('../dist/platform/discovery-service.js');
const {
    normalizeMatterOverrides,
    normalizeMatterRecoveryRequests,
} = require('../dist/platform/matter-override-config.js');
const { normalizeCustomNames } = require('../dist/platform/custom-names-config.js');
const { ConfigIssues } = require('../dist/platform/config-values.js');
const { resolveRuntimeConfig } = require('../dist/platform/runtime-config.js');
const { reportConfigOverrides } = require('../dist/platform/override-reconciliation.js');

function collectingLog() {
    const lines = [];
    const at = (level) => (...args) => lines.push({ level, text: args.map(String).join(' ') });
    return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

const device = (id, type, name = id) => ({ id, type, name, description: name, status: {} });

function service(config) {
    const log = collectingLog();
    return { discovery: new DiscoveryService(config, log), warnings: () => log.lines.filter((l) => l.level === 'warn') };
}

// ---------------------------------------------------------------------------
// MAT-09
// ---------------------------------------------------------------------------

test('MAT-09: matterOverrides as a map with null, string or number values does not throw', () => {
    for (const value of [null, 'x', 7, true, [], undefined]) {
        let built;
        assert.doesNotThrow(() => { built = service({ matterOverrides: { zone_1: value, zone_2: { exposed: false } } }); }, String(value));
        assert.equal(built.discovery.resolveMatterPolicy(device('zone_1', 'zone')).exposed, true);
        assert.equal(built.discovery.resolveMatterPolicy(device('zone_2', 'zone')).exposed, false, 'the valid row still applies');
        if (value !== undefined) assert.match(built.warnings()[0].text, /matterOverrides\.zone_1/);
    }
});

test('MAT-09: the map form follows the same rules as the array form', () => {
    const issues = new ConfigIssues();
    const fromMap = normalizeMatterOverrides({
        zone_18: { name: ' Study ', exposed: false },
        zone_19: { name: 5, exposed: 'false' },
        zone_20: {},
        ' zone_21 ': { name: '' , exposed: true },
    }, issues);
    const fromArray = normalizeMatterOverrides([
        { deviceId: 'zone_18', name: ' Study ', exposed: false },
        { deviceId: 'zone_19', name: 5, exposed: 'false' },
        { deviceId: 'zone_20' },
        { deviceId: ' zone_21 ', name: '', exposed: true },
    ], new ConfigIssues());
    assert.deepEqual(fromMap, fromArray);
    assert.deepEqual(fromMap, { zone_18: { name: 'Study', exposed: false }, zone_21: { exposed: true } });
});

test('MAT-09: a non-object matterOverrides or an invalid row is reported, not thrown', () => {
    for (const config of [5, 'zone_1', true]) {
        const { discovery, warnings } = service({ matterOverrides: config });
        assert.equal(discovery.resolveMatterPolicy(device('zone_1', 'zone')).exposed, true);
        assert.match(warnings()[0].text, /matterOverrides/);
    }
    const { warnings } = service({ matterOverrides: [null, 'x', 3, { deviceId: 9 }, { deviceId: 'zone_1', exposed: 'no' }] });
    assert.equal(warnings().length, 1);
    for (const where of ['matterOverrides[0]', 'matterOverrides[1]', 'matterOverrides[2]', 'matterOverrides[3]', 'matterOverrides[4]']) {
        assert.ok(warnings()[0].text.includes(where), where);
    }
});

test('MAT-09: matterRecoveryRequests as a map is validated like the array', () => {
    const issues = new ConfigIssues();
    assert.deepEqual(
        normalizeMatterRecoveryRequests({ thermostat_1: 2, thermostat_2: null, thermostat_3: 'x', thermostat_4: 0, thermostat_5: 1.5, thermostat_6: {} }, issues),
        { thermostat_1: 2 },
    );
    assert.doesNotThrow(() => normalizeMatterRecoveryRequests({ a: null }));
    assert.doesNotThrow(() => normalizeMatterRecoveryRequests([null, 5, 'x', { deviceId: {} }]));
    assert.doesNotThrow(() => normalizeMatterRecoveryRequests(42));
});

// ---------------------------------------------------------------------------
// PLAT-10
// ---------------------------------------------------------------------------

test('PLAT-10: a customNames map with non-string or empty values is cleaned, and names stay strings', () => {
    const { discovery, warnings } = service({
        customNames: { zones: { 3: 42, 4: '', 5: ' Window ', 6: null }, outputs: { 7: { a: 1 } }, sensors: 'x', bogus: { 1: 'y' } },
    });
    const zone = (id) => device(`zone_${id}`, 'zone');
    assert.equal(discovery.getCustomName(zone(3)), undefined);
    assert.equal(discovery.getCustomName(zone(4)), undefined);
    assert.equal(discovery.getCustomName(zone(5)), 'Window');
    assert.equal(discovery.getCustomName(zone(6)), undefined);
    assert.equal(discovery.getCustomName(device('light_7', 'light')), undefined);
    // The name used for the MQTT slug is the device name, always a string.
    assert.equal(typeof discovery.applyCustomName(zone(3)).name, 'string');
    assert.equal(warnings().length, 1);
    for (const piece of ['customNames.zones', 'customNames.outputs', 'customNames.sensors', 'bogus']) {
        assert.ok(warnings()[0].text.includes(piece), piece);
    }
});

test('PLAT-10: array rows with a non-string name or a bad deviceId are reported with their position', () => {
    const issues = new ConfigIssues();
    const map = normalizeCustomNames([
        { deviceId: 'zone_3', name: 42 }, { deviceId: 'zone_4', name: 'Door' }, { deviceId: 'ZONE_5', name: 'x' }, null, 'x', { deviceId: 6, name: 'y' },
        { deviceId: 'zone_4', name: 'Door 2' }, {}, { deviceId: '', name: '' },
    ], issues);
    assert.deepEqual(map.zones, { 4: 'Door 2' });
    const log = collectingLog();
    issues.flush(log);
    const text = log.lines.map((l) => l.text).join('\n');
    for (const piece of ['customNames[0]', 'customNames[2]', 'customNames[3]', 'customNames[4]', 'customNames[5]', 'more than once']) {
        assert.ok(text.includes(piece), piece);
    }
    assert.ok(!text.includes('customNames[7]') && !text.includes('customNames[8]'), 'the empty UI row is not reported');
});

test('PLAT-10: lookups use own properties only (a panel ID such as constructor names nothing)', () => {
    const { discovery } = service({ customNames: { outputs: { 1: 'Lamp' }, zones: {}, sensors: {}, scenarios: {} } });
    for (const [id, type] of [['light_constructor', 'light'], ['zone___proto__', 'zone'], ['scenario_toString', 'scenario'], ['sensor_temp_hasOwnProperty', 'sensor']]) {
        assert.equal(discovery.getCustomName(device(id, type)), undefined, id);
    }
    assert.equal(discovery.getCustomName(device('light_1', 'light')), 'Lamp');
});

test('PLAT-10: a matterOverrides lookup for a device ID such as constructor finds nothing', () => {
    const { discovery } = service({ matterOverrides: { zone_1: { name: 'X' } } });
    const policy = discovery.resolveMatterPolicy(device('constructor', 'zone', 'Real name'));
    assert.equal(policy.names.matterOverrideName, undefined);
    assert.equal(policy.displayName, 'Real name');
    assert.equal(discovery.resolveMatterPolicy(device('__proto__', 'zone', 'Other')).displayName, 'Other');
});

test('a __proto__ deviceId in an override row cannot pollute the prototype', () => {
    const overrides = normalizeMatterOverrides([{ deviceId: '__proto__', exposed: false }, { deviceId: 'constructor', name: 'n' }]);
    assert.equal(({}).exposed, undefined);
    assert.deepEqual(Object.keys(overrides).sort(), ['__proto__', 'constructor']);
    const { discovery } = service({ matterOverrides: [{ deviceId: '__proto__', exposed: false }] });
    assert.equal(discovery.resolveMatterPolicy(device('zone_1', 'zone')).exposed, true);
});

// ---------------------------------------------------------------------------
// MAT-10: duplicate rows merge
// ---------------------------------------------------------------------------

test('MAT-10: two rows for the same device are merged, not replaced', () => {
    const issues = new ConfigIssues();
    const merged = normalizeMatterOverrides([
        { deviceId: 'zone_1', exposed: false },
        { deviceId: ' zone_1 ', name: 'Hall contact' },
    ], issues);
    assert.deepEqual(merged, { zone_1: { exposed: false, name: 'Hall contact' } });
    const log = collectingLog();
    issues.flush(log);
    assert.equal(log.lines.length, 0, 'no conflict: no warning');

    const { discovery } = service({ matterOverrides: [{ deviceId: 'zone_1', exposed: false }, { deviceId: 'zone_1', name: 'Hall contact' }] });
    const policy = discovery.resolveMatterPolicy(device('zone_1', 'zone'));
    assert.equal(policy.exposed, false);
    assert.equal(policy.displayName, 'Hall contact');
});

test('MAT-10: conflicting duplicate rows warn and the last value wins', () => {
    const { discovery, warnings } = service({ matterOverrides: [
        { deviceId: 'zone_1', exposed: false, name: 'A' }, { deviceId: 'zone_1', exposed: true, name: 'B' },
    ] });
    const policy = discovery.resolveMatterPolicy(device('zone_1', 'zone'));
    assert.equal(policy.exposed, true);
    assert.equal(policy.displayName, 'B');
    assert.equal(warnings().length, 1);
    assert.match(warnings()[0].text, /zone_1/);
    assert.match(warnings()[0].text, /exposed/);
    assert.match(warnings()[0].text, /name/);
});

test('MAT-10: the deviceId is compared exactly after trim; its form is not rewritten', () => {
    const overrides = normalizeMatterOverrides([{ deviceId: 'ZONE_1', exposed: false }, { deviceId: '1', exposed: false }, { deviceId: ' zone_1', exposed: true }]);
    assert.deepEqual(Object.keys(overrides).sort(), ['1', 'ZONE_1', 'zone_1']);
    const { discovery } = service({ matterOverrides: [{ deviceId: 'ZONE_1', exposed: false }] });
    assert.equal(discovery.resolveMatterPolicy(device('zone_1', 'zone')).exposed, true);
});

// ---------------------------------------------------------------------------
// MAT-10: the end-of-sync report
// ---------------------------------------------------------------------------

function report(config, discovered) {
    const log = collectingLog();
    const runtime = resolveRuntimeConfig({ platform: 'x', ...config }, collectingLog());
    reportConfigOverrides(runtime, new Set(discovered), log);
    return log.lines.filter((l) => l.level === 'warn').map((l) => l.text);
}

test('MAT-10: one warning lists the override, recovery and name entries that match no discovered device', () => {
    const warnings = report({
        matterOverrides: [{ deviceId: 'zone_1', exposed: false }, { deviceId: 'ZONE_2', exposed: false }, { deviceId: '3', name: 'X' }, { deviceId: 'light_99', name: 'Y' }],
        matterRecoveryRequests: [{ deviceId: 'thermostat_18', generation: 1 }, { deviceId: 'thermostat_77', generation: 1 }],
        customNames: [{ deviceId: 'zone_1', name: 'ok' }, { deviceId: 'light_5', name: 'ok' }, { deviceId: 'zone_40', name: 'lost' }, { deviceId: 'sensor_9', name: 'lost too' }],
    }, ['zone_1', 'zone_2', 'zone_3', 'light_5', 'thermostat_18', 'sensor_temp_9']);
    const unmatched = warnings.filter((text) => /match no device/.test(text));
    assert.equal(unmatched.length, 1, warnings.join('\n'));
    const text = unmatched[0];
    assert.match(text, /"ZONE_2" \(did you mean zone_2\?\)/);
    assert.match(text, /"3" \(did you mean zone_3\?\)/);
    assert.match(text, /"light_99"/);
    assert.match(text, /matterRecoveryRequests: "thermostat_77"/);
    assert.match(text, /customNames: "zone_40"/);
    assert.doesNotMatch(text, /thermostat_18|"zone_1"|"light_5"|sensor_9/);
});

test('MAT-10: the "hides N device(s)" warning counts only devices the panel really reported', () => {
    const config = { matterOverrides: [{ deviceId: 'zone_1', exposed: false }, { deviceId: 'zone_2', exposed: false }, { deviceId: 'zone_3', exposed: true }] };
    const warnings = report(config, ['zone_1', 'zone_3']);
    const hides = warnings.filter((text) => /hides/.test(text));
    assert.equal(hides.length, 1);
    assert.match(hides[0], /hides 1 device\(s\)/);
    assert.match(hides[0], /zone_1/);
    assert.doesNotMatch(hides[0], /zone_2/);
    assert.deepEqual(report(config, ['zone_3']).filter((text) => /hides/.test(text)), []);
});

test('MAT-10: nothing is reported when every entry hooks a device', () => {
    assert.deepEqual(report({ matterOverrides: [{ deviceId: 'zone_1', name: 'A' }], customNames: { zones: { 1: 'A' } } }, ['zone_1']), []);
    assert.deepEqual(report({}, []), []);
});

test('MAT-10: an override on an excluded device still hooks a device', () => {
    // Excluded devices are discovered devices too: no false "matches nothing".
    assert.deepEqual(report({ excludeZones: ['1'], matterOverrides: [{ deviceId: 'zone_1', name: 'A' }] }, ['zone_1']), []);
});
