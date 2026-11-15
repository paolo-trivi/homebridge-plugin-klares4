'use strict';

// TD-DOC-10: docs/en and docs/it are the same pages in two languages, the
// index lists them, nothing points to a missing file, and the page the README
// promised (MQTT, Matter, privacy) exist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { codeBlocks, headings, linkProblems } = require('./fixtures/markdown.js');

const root = path.join(__dirname, '..');
const PAGES = [
    ['README.md', 'README.md'],
    ['plugin-overview.md', 'panoramica-plugin.md'],
    ['config-and-ui.md', 'configurazione-e-ui.md'],
    ['websocket-protocol.md', 'protocollo-websocket.md'],
    ['domus-thermostats.md', 'termostati-domus.md'],
    ['mqtt.md', 'mqtt.md'],
    ['matter.md', 'matter.md'],
    ['privacy-and-debug-file.md', 'privacy-e-file-di-debug.md'],
    ['operations-debug.md', 'operazioni-debug.md'],
];
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const tableRows = (text) => text.split('\n').filter((line) => /^\|.*\|\s*$/.test(line)).length;
const bullets = (text) => text.split('\n').filter((line) => /^\s*(?:[-*]|\d+\.) /.test(line)).length;

test('docs/en and docs/it contain exactly the same pages', () => {
    const list = (dir) => fs.readdirSync(path.join(root, 'docs', dir)).filter((name) => name.endsWith('.md')).sort();
    assert.deepEqual(list('en'), PAGES.map(([en]) => en).sort());
    assert.deepEqual(list('it'), PAGES.map(([, it]) => it).sort());
});

for (const [en, it] of PAGES) {
    test(`docs ${en} and ${it} have the same structure`, () => {
        const english = read(`docs/en/${en}`);
        const italian = read(`docs/it/${it}`);
        for (const level of [1, 2, 3, 4]) assert.equal(headings(italian, level).length, headings(english, level).length, `headings level ${level}`);
        assert.equal(tableRows(italian), tableRows(english), 'table rows');
        assert.equal(bullets(italian), bullets(english), 'list items');
        const withoutComments = (blocks) => blocks.map((block) => block.replace(/\s+#.*$/gm, ''));
        assert.deepEqual(withoutComments(codeBlocks(italian)), withoutComments(codeBlocks(english)), 'code blocks');
    });

    test(`docs ${en} and ${it}: links resolve`, () => {
        assert.deepEqual(linkProblems(read(`docs/en/${en}`), root, `docs/en/${en}`), []);
        assert.deepEqual(linkProblems(read(`docs/it/${it}`), root, `docs/it/${it}`), []);
    });
}

test('the indexes list every page', () => {
    const top = read('docs/README.md');
    for (const [en, it] of PAGES) {
        assert.ok(top.includes(`./en/${en}`), en);
        assert.ok(top.includes(`./it/${it}`), it);
    }
    for (const [dir, index] of [['en', read('docs/en/README.md')], ['it', read('docs/it/README.md')]]) {
        for (const [en, it] of PAGES.slice(1)) assert.ok(index.includes(`./${dir === 'en' ? en : it}`), `${dir}: ${dir === 'en' ? en : it}`);
    }
    assert.deepEqual(linkProblems(top, root, 'docs/README.md'), []);
});

test('no page points at something that is not in the repository', () => {
    const privacy = new Set(['privacy-and-debug-file.md', 'privacy-e-file-di-debug.md']);
    const texts = [...PAGES.flatMap(([en, it]) => [read(`docs/en/${en}`), read(`docs/it/${it}`)]), read('README.md')];
    // Only the privacy pages may name Sentry, to say it was removed.
    for (const [en, it] of PAGES.filter(([en]) => !privacy.has(en))) {
        assert.doesNotMatch(read(`docs/en/${en}`), /Sentry/);
        assert.doesNotMatch(read(`docs/it/${it}`), /Sentry/);
    }
    for (const text of texts) {
        for (const match of text.matchAll(/`(scripts\/[\w./-]+)`/g)) {
            assert.ok(fs.existsSync(path.join(root, match[1])), `${match[1]} is cited but not tracked`);
        }
        assert.doesNotMatch(text, /MATTER_TROUBLESHOOTING|debug-thermostat-routing/);
    }
    assert.ok(!fs.existsSync(path.join(root, 'docs', 'MATTER_TROUBLESHOOTING.md')), 'absorbed into matter.md');
});

test('the pages say what 2.3.0 changed: no telemetry, fail-closed exposure, confidential debug file', () => {
    for (const dir of ['en', 'it']) {
        const all = fs.readdirSync(path.join(root, 'docs', dir)).map((name) => read(`docs/${dir}/${name}`)).join('\n');
        assert.match(all, /exposeOutputs/);
        assert.match(all, /mqtt\.commands/);
        assert.match(all, /<prefix>\/status/);
        assert.match(all, /0600/);
        assert.doesNotMatch(all, /with PINs masked|con i PIN mascherati|PIN gia mascherati/);
    }
});

test('the audit archive index lists every audit document and its links resolve', () => {
    const dir = path.join(root, 'docs', 'audit');
    const index = read('docs/audit/README.md');
    for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.md') && file !== 'README.md')) {
        assert.ok(index.includes(`(${name})`), `${name} is not in the audit index`);
        assert.deepEqual(linkProblems(read(`docs/audit/${name}`), root, `docs/audit/${name}`), [], name);
    }
    assert.deepEqual(linkProblems(index, root, 'docs/audit/README.md'), []);
});

test('the public review summary carries no installation data (addresses, PINs, device lists)', () => {
    const text = read('docs/audit/2026-11-14-review-2.2.0.md');
    assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    assert.doesNotMatch(text, /\b(?:zone|light|cover|gate|thermostat|scenario)_\d+\b/);
    assert.doesNotMatch(text, /\bPIN\b[^.\n]{0,20}\b\d{4,8}\b/);
});
