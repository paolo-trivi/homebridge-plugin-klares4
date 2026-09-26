const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeCustomNames, toCustomNameEntries } = require('../dist/platform/custom-names-config.js');
const { DiscoveryService } = require('../dist/platform/discovery-service.js');

const log = { info() {}, warn() {}, error() {}, debug() {} };

test('F02: the legacy map form is still accepted unchanged', () => {
    const legacy = { outputs: { 37: 'PC Studio' }, zones: { 3: 'Finestra' } };
    assert.deepEqual(normalizeCustomNames(legacy), {
        zones: { 3: 'Finestra' }, outputs: { 37: 'PC Studio' }, sensors: {}, scenarios: {},
    });
});

test('F02: the array form maps every device ID family to its category', () => {
    const normalized = normalizeCustomNames([
        { deviceId: 'light_37', name: 'PC Studio' },
        { deviceId: 'cover_7', name: ' Tapparella Test ' },
        { deviceId: 'output_12', name: 'Uscita' },
        { deviceId: 'zone_3', name: 'Finestra' },
        { deviceId: 'sensor_temp_1', name: 'Sala' },
        { deviceId: 'sensor_2', name: 'Bagno' },
        { deviceId: 'scenario_9', name: 'Notte' },
    ]);
    assert.deepEqual(normalized, {
        zones: { 3: 'Finestra' },
        outputs: { 37: 'PC Studio', 7: 'Tapparella Test', 12: 'Uscita' },
        sensors: { 1: 'Sala', 2: 'Bagno' },
        scenarios: { 9: 'Notte' },
    });
});

test('F02: malformed rows are dropped instead of stopping the platform', () => {
    const normalized = normalizeCustomNames([
        null, {}, { deviceId: 'light_1' }, { name: 'orphan' }, { deviceId: 'nonsense_4', name: 'x' }, { deviceId: 'zone_', name: 'x' },
    ]);
    assert.deepEqual(normalized, { zones: {}, outputs: {}, sensors: {}, scenarios: {} });
});

test('F02: KSA-derived names are written in the array form and read back identically', () => {
    const derived = { outputs: { 18: 'Riscaldamento Sala' }, zones: { 1: 'Ingresso' }, sensors: { 1: 'Term. Sala' }, scenarios: { 4: 'Notte' } };
    const entries = toCustomNameEntries(derived);
    assert.ok(Array.isArray(entries));
    assert.deepEqual(normalizeCustomNames(entries), derived);
});

test('F02: DiscoveryService applies array-form custom names', () => {
    const discovery = new DiscoveryService({ customNames: [
        { deviceId: 'light_37', name: 'PC Studio' },
        { deviceId: 'sensor_1', name: 'Sala' },
    ] }, log);
    assert.equal(discovery.getCustomName({ id: 'light_37', type: 'light', name: 'PC', status: {} }), 'PC Studio');
    assert.equal(discovery.getCustomName({ id: 'sensor_hum_1', type: 'sensor', name: 'x', status: {} }), 'Sala - Umidita');
});

test('F02/F38: no per-device setting in the UI schema is a free-form map or an unset boolean', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
    const offenders = [];
    const walk = (node, where) => {
        if (!node || typeof node !== 'object') return;
        if (node.additionalProperties && typeof node.additionalProperties === 'object') offenders.push(`${where}: additionalProperties`);
        if (node.patternProperties) offenders.push(`${where}: patternProperties`);
        if (node.type === 'array' && node.items?.properties) {
            for (const [key, prop] of Object.entries(node.items.properties)) {
                // The UI writes an untouched checkbox as false, which silently flips the setting.
                if (prop.type === 'boolean' && prop.default === undefined) offenders.push(`${where}[].${key}: boolean without default`);
                // F41: the UI renders one empty row and materializes item defaults, writing a junk row on every save.
                if (prop.type !== 'boolean' && prop.default !== undefined) offenders.push(`${where}[].${key}: non-boolean default`);
            }
        }
        for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${where}.${key}`);
        if (node.items) walk(node.items, `${where}[]`);
    };
    walk(schema.schema, 'schema');
    assert.deepEqual(offenders, []);
});

test('F38: overrides that hide devices from Matter are reported at startup', () => {
    const warnings = [];
    new DiscoveryService({ matterOverrides: [
        { deviceId: 'zone_18', name: 'Contatto Studio', exposed: false },
        { deviceId: 'zone_19', name: 'Contatto Cucina', exposed: true },
    ] }, { ...log, warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /zone_18/);
    assert.doesNotMatch(warnings[0], /zone_19/);
});
