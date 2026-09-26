const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('every schema property is reachable from the layout', () => {
    const layoutKeys = new Set();
    const walkLayout = (node) => {
        if (!node) return;
        if (typeof node === 'string') { layoutKeys.add(node.replace(/\[\]/g, '')); return; }
        if (Array.isArray(node)) { node.forEach(walkLayout); return; }
        if (node.key) layoutKeys.add(node.key.replace(/\[\]/g, ''));
        walkLayout(node.items);
    };
    walkLayout(schemaFile.layout);
    const missing = [];
    const walkSchema = (node, prefix) => {
        for (const [key, value] of Object.entries(node.properties ?? {})) {
            const full = prefix ? `${prefix}.${key}` : key;
            if (value.type === 'object' && value.properties) walkSchema(value, full);
            else if (!layoutKeys.has(full)) missing.push(full);
        }
    };
    walkSchema(schemaFile.schema, '');
    assert.deepEqual(missing, []);
});

test('no stale version or hard-coded capture duration in the UI texts', () => {
    assert.doesNotMatch(schemaFile.footerDisplay, /Versione \d/);
    const texts = JSON.stringify(schemaFile.layout);
    assert.doesNotMatch(texts, /successivi 60 secondi/);
    assert.doesNotMatch(texts, /RAW \(60 secondi\)/);
});
