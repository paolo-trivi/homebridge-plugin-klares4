'use strict';

// The settings form (config.schema.json), the layout and the runtime config
// must describe the same keys: a key the code reads but the form lacks is
// deleted by the Homebridge UI the next time the user saves.

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveRuntimeConfig, reportDeprecatedKeys } = require('../dist/platform/runtime-config.js');
const { NUMERIC_LIMITS } = require('../dist/platform/runtime-config-limits.js');
const {
    loadSchemaFile, layoutKeys, schemaPaths, formModel, validate, completeConfig, isObject,
} = require('./fixtures/schema-model.js');

const schemaFile = loadSchemaFile();
const rootSchema = schemaFile.schema;

/** Keys of the form that the plugin never reads: `name` is Homebridge's, `showAdvanced` only drives the form. */
const FORM_ONLY = new Set(['name', 'showAdvanced']);
/** Keys the plugin reads that are not part of the form. */
const NOT_IN_FORM = new Set([
    'platform',
    // Retired in 2.3.0: still read so that an existing config.json is accepted, but it has no effect and is not in the form.
    'ksaImport.applyExclusionSuggestions',
]);

function collectingLog() {
    const lines = [];
    const at = (level) => (...args) => lines.push({ level, text: args.map(String).join(' ') });
    return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

/** Wraps a config so every property the code touches is recorded, at any depth. */
function recordReads(value, path, reads) {
    if (value === null || typeof value !== 'object') return value;
    const isArray = Array.isArray(value);
    return new Proxy(value, {
        get(target, property, receiver) {
            if (typeof property === 'string' && !isArray && property !== 'then' && property !== 'toJSON'
                && property !== 'constructor' && property !== '__proto__') {
                reads.add(path ? `${path}.${property}` : property);
            }
            const inner = Reflect.get(target, property, receiver);
            if (isArray && typeof property === 'string' && /^\d+$/.test(property)) {
                return recordReads(inner, `${path}[]`, reads);
            }
            if (isArray) return inner;
            return typeof property === 'string' ? recordReads(inner, path ? `${path}.${property}` : property, reads) : inner;
        },
    });
}

test('the complete test configuration is valid for the schema and covers every property', () => {
    const config = completeConfig();
    const { platform, ...form } = config;
    assert.equal(platform, 'Lares4Complete');
    assert.deepEqual(validate(form, rootSchema, 'config'), []);

    const present = (path) => {
        let nodes = [config];
        for (const part of path.split('.')) {
            const name = part.endsWith('[]') ? part.slice(0, -2) : part;
            nodes = nodes.flatMap((node) => {
                const inner = isObject(node) ? node[name] : undefined;
                return part.endsWith('[]') ? (Array.isArray(inner) ? inner : []) : [inner];
            });
        }
        return nodes.some((node) => node !== undefined);
    };
    const absent = schemaPaths(rootSchema).map(({ path }) => path).filter((path) => !present(path));
    assert.deepEqual(absent, [], 'the fixture must set every property, or a lost key could go unnoticed');
});

test('a complete configuration is read without a single warning, and nothing but the schema keys is read', () => {
    const reads = new Set();
    const log = collectingLog();
    resolveRuntimeConfig(recordReads(completeConfig(), '', reads), log);
    assert.deepEqual(log.lines, [], 'every value of the fixture is valid');

    const schemaKeys = new Set(schemaPaths(rootSchema).map(({ path }) => path));
    const unknown = [...reads].filter((key) => !schemaKeys.has(key) && !NOT_IN_FORM.has(key));
    assert.deepEqual(unknown.sort(), [], 'read by the code but missing from config.schema.json: the UI would delete them');

    const unread = [...schemaKeys].filter((key) => !reads.has(key) && !FORM_ONLY.has(key));
    // Objects and arrays are read through their children; only leaves must have been touched.
    const leaves = new Set(schemaPaths(rootSchema).filter(({ container }) => !container).map(({ path }) => path));
    assert.deepEqual(unread.filter((key) => leaves.has(key)).sort(), [], 'in the form but never read: a dead option');
});

test('config -> form model -> config keeps every key of a complete configuration, unaltered', () => {
    const config = completeConfig();
    const keys = layoutKeys(schemaFile.layout);
    const { platform, ...before } = config;
    const after = formModel(before, keys);
    assert.deepEqual(after, before);

    // And what the plugin understands from it is the same.
    const direct = resolveRuntimeConfig(config, collectingLog());
    const viaForm = resolveRuntimeConfig({ platform, ...after }, collectingLog());
    assert.deepEqual(viaForm, direct);
});

test('the round-trip simulation does lose a key the layout does not reach (the check can fail)', () => {
    const keys = layoutKeys(schemaFile.layout);
    keys.delete('exposeOutputs[].exposeAs');
    keys.delete('mqtt.commands');
    const after = formModel(completeConfig(), keys);
    assert.equal(after.exposeOutputs[0].exposeAs, undefined);
    assert.equal(after.mqtt.commands, undefined);
});

test('a key that is still in an existing config.json but left the form is tolerated and ignored', () => {
    const log = collectingLog();
    const raw = { platform: 'Lares4Complete', ip: '192.0.2.10', pin: '123456', telemetry: true, ksaImport: { enabled: true, applyExclusionSuggestions: true } };
    const runtime = resolveRuntimeConfig(raw, log);
    assert.equal(runtime.exclusions.excludeZones.length, 0, 'applyExclusionSuggestions does not touch the exclusion lists');
    assert.deepEqual(log.lines.filter((line) => line.level !== 'info'), []);

    reportDeprecatedKeys(raw, log);
    const infos = log.lines.filter((line) => line.level === 'info').map((line) => line.text);
    assert.equal(infos.filter((text) => /telemetry/.test(text)).length, 1, 'one line says the key is ignored');
});

test('numeric limits and defaults in the schema equal the runtime table, key by key', () => {
    for (const [key, spec] of Object.entries(NUMERIC_LIMITS)) {
        const node = key.split('.').reduce((current, part) => current.properties[part], rootSchema);
        assert.equal(node.type, spec.integer ? 'integer' : 'number', key);
        assert.equal(node.default, spec.default, `${key} default`);
        if (spec.oneOf) {
            const allowed = node.enum ?? node.oneOf.map((entry) => entry.const);
            assert.deepEqual([...allowed].sort(), [...spec.oneOf].sort(), `${key} allowed values`);
        } else {
            assert.equal(node.minimum, spec.min, `${key} minimum`);
            assert.equal(node.maximum, spec.max, `${key} maximum`);
        }
    }
    // Every numeric property of the schema is in the table.
    const numeric = schemaPaths(rootSchema)
        .filter(({ node, path }) => (node.type === 'integer' || node.type === 'number') && !path.includes('[]'))
        .map(({ path }) => path);
    assert.deepEqual(numeric.sort(), Object.keys(NUMERIC_LIMITS).sort());
    // Row fields are validated row by row in the platform; the one numeric row field is a positive integer.
    const generation = rootSchema.properties.matterRecoveryRequests.items.properties.generation;
    assert.equal(generation.type, 'integer');
    assert.equal(generation.minimum, 1);
});

test('boolean and text defaults in the schema equal what the runtime applies when the key is absent', () => {
    const runtime = resolveRuntimeConfig({ platform: 'Lares4Complete', ip: '192.0.2.10', pin: '123456', mqtt: {} }, collectingLog());
    const mismatches = [];
    for (const { path, node, container } of schemaPaths(rootSchema)) {
        if (container || node.default === undefined || path === 'name' || path === 'showAdvanced' || path.includes('[]')) continue;
        if (typeof node.default === 'number') continue; // numbers: the limits test above
        const actual = path.split('.').reduce((value, part) => value?.[part], runtime);
        if (actual !== node.default) mismatches.push(`${path}: schema ${JSON.stringify(node.default)}, runtime ${JSON.stringify(actual)}`);
    }
    assert.deepEqual(mismatches, []);
    for (const key of ['exposeOutputs', 'exposeScenarios']) assert.deepEqual(runtime[key], []);
});

test('an exposeOutputs row without exposeAs means "light", as the schema default says', () => {
    const row = rootSchema.properties.exposeOutputs.items.properties.exposeAs;
    const runtime = resolveRuntimeConfig({ platform: 'Lares4Complete', ip: '192.0.2.10', pin: '123456', exposeOutputs: [{ outputId: '3' }] }, collectingLog());
    assert.deepEqual(runtime.exposeOutputs, [{ outputId: '3', exposeAs: row.default }]);
});
