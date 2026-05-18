'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PLUGIN_VERSION, PLUGIN_VERSION_RAW } = require('../dist/plugin-version');
const pkg = require('../package.json');

test('PLUGIN_VERSION_RAW matches package.json version exactly', () => {
    assert.equal(PLUGIN_VERSION_RAW, pkg.version);
});

test('PLUGIN_VERSION is HAP/Matter-compliant semver (M.m.p, no suffix)', () => {
    assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/);
});

test('PLUGIN_VERSION is a prefix of PLUGIN_VERSION_RAW', () => {
    assert.ok(
        PLUGIN_VERSION_RAW.startsWith(PLUGIN_VERSION),
        `Expected "${PLUGIN_VERSION_RAW}" to start with "${PLUGIN_VERSION}"`,
    );
});
