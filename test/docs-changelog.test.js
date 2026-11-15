'use strict';

// TD-DOC-13: the 2.3.0 section is written for users, leads with the upgrade
// notes, follows Keep a Changelog, and the history has working links.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { linkProblems } = require('./fixtures/markdown.js');

const root = path.join(__dirname, '..');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const unreleased = changelog.slice(changelog.indexOf('## [Unreleased]'), changelog.indexOf('\n## [2.2.0]'));

test('[Unreleased] opens with the upgrade notes and has the Keep a Changelog groups', () => {
    const headings = unreleased.split('\n').filter((line) => /^### /.test(line)).map((line) => line.slice(4));
    assert.equal(headings[0], 'Upgrading from 2.2.x: read first');
    for (const group of ['Security', 'Changed', 'Fixed', 'Added', 'Removed']) assert.ok(headings.includes(group), group);
    assert.ok(unreleased.length > 15000, 'a complete section');
});

test('[Unreleased] is not dated and package.json is not bumped by this work', () => {
    assert.match(changelog, /^## \[Unreleased\]$/m);
    assert.doesNotMatch(unreleased, /^## \[Unreleased\] - /m);
});

test('the upgrade notes cover every change of behavior or default', () => {
    const upgrade = unreleased.slice(0, unreleased.indexOf('\n### Security'));
    for (const needle of [
        'exposeOutputs', 'exposeScenarios', 'Exposure policy:', 'telemetry', 'Thermostat', 'three complete synchronizations',
        'commandTimeoutMs', 'once per hour', '<prefix>/status', 'mqtt.commands', 'confidential', 'allowInsecureTls', 'Node.js 22.12',
        'Homebridge 1.x', 'No Response', '0600', 'percent-encoded', 'two thermostats', 'ACL',
    ]) {
        assert.ok(upgrade.includes(needle), `missing from the upgrade notes: ${needle}`);
    }
});

test('[Unreleased] has no internal finding IDs and no real device names', () => {
    assert.doesNotMatch(unreleased, /\b(?:WS|PLAT|MAT|TH|SP|TD-DOC|TD-T|TD-Q|MQ)-\d+\b/);
    assert.doesNotMatch(unreleased, /\bF\d{2}\b/);
});

test('the history is current: summary, migration guide and version links', () => {
    assert.match(changelog, /\*\*2\.3\.x\*\*/);
    assert.match(changelog, /### From 2\.2\.x to 2\.3\.0/);
    assert.match(changelog, /^\[Unreleased\]: https:\/\/github\.com\/paolo-trivi\/homebridge-plugin-klares4\/compare\/v2\.2\.0\.\.\.HEAD$/m);
    assert.match(changelog, /^\[2\.2\.0\]: /m);
    assert.deepEqual(linkProblems(changelog, root, 'CHANGELOG.md'), []);
    assert.doesNotMatch(changelog, /1\.1\.x\*\*: MQTT integration/);
});
