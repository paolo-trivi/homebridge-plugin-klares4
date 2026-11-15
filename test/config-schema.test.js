const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { layoutKeys, schemaNodeAt, schemaPaths, validate, isObject } = require('./fixtures/schema-model.js');

const schemaFile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
const props = schemaFile.schema.properties;

test('port has no default: the UI would write 443 even with https off', () => {
    assert.equal(props.port.default, undefined);
});

test('keys the code reads are declared, so the UI keeps them', () => {
    assert.equal(props.mqtt.properties.port.type, 'integer');
    assert.equal(props.mqtt.properties.port.default, undefined, 'a default would override the port in the broker URL');
    const pairs = props.domusThermostat.properties.manualCommandPairs;
    assert.equal(pairs.type, 'array');
    assert.deepEqual(Object.keys(pairs.items.properties).sort(), ['commandThermostatId', 'thermostatOutputId']);
    assert.match('thermostat_18', new RegExp(pairs.items.properties.thermostatOutputId.pattern));
    assert.match('18', new RegExp(pairs.items.properties.thermostatOutputId.pattern));
    assert.match('3', new RegExp(pairs.items.properties.commandThermostatId.pattern));
});

test('exposePartialArmScenarios is an explicit opt-in, off by default', () => {
    const prop = props.exposePartialArmScenarios;
    assert.equal(prop.type, 'boolean');
    assert.equal(prop.default, false);
    assert.match(prop.description, /PIN/);
});

test('every schema property is reachable from the layout, array item fields included', () => {
    // The UI rebuilds config.json from its form: a property the layout does not reach is deleted on save.
    const keys = layoutKeys(schemaFile.layout);
    const missing = [];
    for (const { path: full, node, container } of schemaPaths(schemaFile.schema)) {
        if (container && node.type === 'object') continue; // its children are checked on their own
        if (!keys.has(full) && !keys.has(`${full}[]`)) missing.push(full);
        if (node.type === 'array' && node.items?.type !== 'object' && !keys.has(`${full}[]`)) missing.push(`${full}[]`);
    }
    assert.deepEqual(missing, []);
});

test('every layout key points to a schema property', () => {
    const dangling = [...layoutKeys(schemaFile.layout)].filter((key) => schemaNodeAt(schemaFile.schema, key) === undefined);
    assert.deepEqual(dangling, []);
});

test('per-device settings are arrays of typed objects, never maps the UI would drop', () => {
    for (const key of ['matterOverrides', 'matterRecoveryRequests', 'customNames', 'exposeOutputs', 'exposeScenarios']) {
        assert.equal(props[key].type, 'array', key);
        assert.equal(props[key].items.type, 'object', key);
        assert.ok(Object.keys(props[key].items.properties).length > 0, key);
    }
    assert.equal(props.exposeOutputs.default.length, 0);
    assert.equal(props.exposeScenarios.default.length, 0);
});

test('exposeOutputs rows: a numeric outputId and the single exposeAs value "light"', () => {
    const row = props.exposeOutputs.items.properties;
    assert.deepEqual(Object.keys(row).sort(), ['exposeAs', 'outputId']);
    assert.equal(row.outputId.required, true);
    assert.deepEqual(row.exposeAs.enum, ['light']);
    assert.equal(row.exposeAs.default, undefined, 'an item default makes the UI write a junk row on every save');
    assert.match(row.exposeAs.description, /empty means light/);
    for (const id of ['1', '12', '115']) assert.match(id, new RegExp(row.outputId.pattern));
    for (const id of ['', 'light_12', '1.5', ' 12']) assert.doesNotMatch(id, new RegExp(row.outputId.pattern));
    assert.deepEqual(validate([{ outputId: '12', exposeAs: 'light' }], props.exposeOutputs, 'exposeOutputs'), []);
    assert.notDeepEqual(validate([{ outputId: '12', exposeAs: 'siren' }], props.exposeOutputs, 'exposeOutputs'), []);
});

test('exposeScenarios rows: a numeric scenarioId', () => {
    const row = props.exposeScenarios.items.properties;
    assert.deepEqual(Object.keys(row), ['scenarioId']);
    assert.equal(row.scenarioId.required, true);
    assert.match('4', new RegExp(row.scenarioId.pattern));
    assert.doesNotMatch('scenario_4', new RegExp(row.scenarioId.pattern));
});

test('mqtt.commands is a boolean that defaults to true and sits right after mqtt.enabled', () => {
    const mqtt = props.mqtt.properties;
    assert.equal(mqtt.commands.type, 'boolean');
    assert.equal(mqtt.commands.default, true);
    assert.deepEqual(Object.keys(mqtt).slice(0, 2), ['enabled', 'commands']);
    assert.match(mqtt.commands.description, /\.\.\/set|\/set/);
});

test('retired and removed keys are not in the form', () => {
    assert.equal(props.telemetry, undefined, 'telemetry was removed in 2.3.0');
    assert.equal(props.ksaImport.properties.applyExclusionSuggestions, undefined);
    assert.equal(props.ksaImport.default.applyExclusionSuggestions, undefined);
    const text = JSON.stringify(schemaFile);
    assert.doesNotMatch(text, /telemetry|telemetria|sentry|applyExclusionSuggestions/i);
});

test('mqtt.port is documented the way the code behaves: the URL port is used when it is empty', () => {
    const { description } = props.mqtt.properties.port;
    assert.doesNotMatch(description, /sempre|always/i, 'the old text told users to always set it');
    assert.match(description, /URL/);
    assert.match(description, /1883/);
});

test('texts are in one language (English) and every property has a title', () => {
    const italian = /\b(del|della|dei|delle|nel|nella|sul|alla|sono|può|centrale|dispositiv[oi]|abilita|aggiungi|avvio|tapparell[ae]|livello|nomi|stanze?)\b/i;
    const offenders = [];
    const walk = (node, where) => {
        if (typeof node === 'string') { if (italian.test(node)) offenders.push(where); return; }
        if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${where}[${index}]`)); return; }
        if (isObject(node)) for (const [key, value] of Object.entries(node)) walk(value, `${where}.${key}`);
    };
    walk(schemaFile, '');
    assert.deepEqual(offenders, []);
    const untitled = schemaPaths(schemaFile.schema).filter(({ node }) => node.title === undefined).map(({ path: full }) => full);
    // `temperatureDefaults` style objects carry a title too; array item fields are titled in the layout or the schema.
    assert.deepEqual(untitled, []);
});

test('texts that depend on the code are stated as the code behaves', () => {
    assert.doesNotMatch(props.allowInsecureTls.description, /Node 24/, 'the legacy renegotiation is not tied to one Node version');
    assert.match(props.commandTimeoutMs.description, /thermostat/i);
    assert.match(props.domusThermostat.properties.sensorFreshnessMs.description, /realtime/i);
    assert.match(props.temperatureDefaults.description, /MQTT/);
    assert.match(props.temperatureDefaults.description, /Matter/);
    assert.match(props.generateDebugFile.description, /confidential/i);
    assert.match(props.pin.description, /clear text/i);
});

test('no stale version or hard-coded capture duration in the UI texts', () => {
    assert.doesNotMatch(schemaFile.footerDisplay, /Versione? \d/);
    const texts = JSON.stringify(schemaFile.layout);
    assert.doesNotMatch(texts, /successivi 60 secondi|RAW \(60 secondi\)/);
    assert.doesNotMatch(texts, /next 60 seconds|RAW \(60 seconds\)/);
});
