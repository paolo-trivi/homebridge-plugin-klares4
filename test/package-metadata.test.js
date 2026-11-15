'use strict';

// TD-DOC-14: the package metadata describes what the plugin does, in English.

const test = require('node:test');
const assert = require('node:assert/strict');

const pkg = require('../package.json');

test('description is English and names HomeKit, Matter and MQTT', () => {
    for (const word of ['HomeKit', 'Matter', 'MQTT', 'Lares4']) assert.match(pkg.description, new RegExp(word));
    assert.doesNotMatch(pkg.description, /\b(per|sistemi|completo|tapparelle|termostati)\b/i);
});

test('displayName is set and the keywords cover the ecosystems', () => {
    assert.equal(typeof pkg.displayName, 'string');
    assert.ok(pkg.displayName.length > 0);
    for (const keyword of ['homebridge-plugin', 'homekit', 'matter', 'mqtt', 'ksenia', 'lares4']) {
        assert.ok(pkg.keywords.includes(keyword), keyword);
    }
});

test('the package ships what the documentation links to', () => {
    for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE', 'config.schema.json']) assert.ok(pkg.files.includes(file), file);
});
