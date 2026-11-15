'use strict';

// TD-DOC-05, TD-DOC-09: the two halves of the README say the same thing, and
// its configuration tables list every key of config.schema.json with the
// default and the limits the schema (and the runtime) use.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadSchemaFile, schemaPaths } = require('./fixtures/schema-model.js');
const { splitHalves, tableAfter, codeBlocks, headings, linkProblems } = require('./fixtures/markdown.js');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const schema = loadSchemaFile().schema;
const { english, italian } = splitHalves(readme, '## English', '## Italiano');

const DEFAULT_OVERRIDES = { ip: 'required', pin: 'required', port: '443 / 80' };

/** Keys documented one row each: every schema leaf, and arrays as a single row. */
function documentedKeys() {
    return schemaPaths(schema).filter(({ path: key, node }) => !key.includes('[]') && node.type !== 'object');
}

function expectedDefault(key, node) {
    if (DEFAULT_OVERRIDES[key]) return DEFAULT_OVERRIDES[key];
    if (node.type === 'array') return '[]';
    if (node.default === undefined) return '—';
    return typeof node.default === 'string' ? JSON.stringify(node.default) : String(node.default);
}

function expectedLimits(node) {
    const allowed = node.enum ?? node.oneOf?.map((entry) => entry.const);
    if (allowed && (node.type === 'integer' || node.type === 'number')) return allowed.join(', ');
    if (node.minimum !== undefined && node.maximum !== undefined) return `${node.minimum}..${node.maximum}`;
    return '—';
}

const strip = (cell) => cell.replace(/`/g, '').trim();

for (const [label, half, heading] of [
    ['English', english, '#### Configuration parameters'],
    ['Italian', italian, '#### Parametri di configurazione'],
]) {
    test(`README ${label}: the configuration table lists every schema key once, with its type, default and limits`, () => {
        const rows = tableAfter(half, heading);
        const byKey = new Map(rows.map((row) => [strip(row[0]), row]));
        assert.equal(byKey.size, rows.length, 'a key is listed twice');

        const expected = documentedKeys();
        assert.deepEqual([...byKey.keys()].sort(), expected.map(({ path: key }) => key).sort());

        const problems = [];
        for (const { path: key, node } of expected) {
            const [, type, defaultCell, limitsCell, description] = byKey.get(key);
            if (strip(type) !== node.type) problems.push(`${key}: type ${strip(type)} != ${node.type}`);
            if (strip(defaultCell).replace('obbligatorio', 'required') !== expectedDefault(key, node)) {
                problems.push(`${key}: default "${strip(defaultCell)}" != "${expectedDefault(key, node)}"`);
            }
            if (strip(limitsCell) !== expectedLimits(node)) problems.push(`${key}: limits "${strip(limitsCell)}" != "${expectedLimits(node)}"`);
            if (description.length < 15) problems.push(`${key}: no description`);
            if (node.type === 'array' && node.items?.type === 'object') {
                for (const field of Object.keys(node.items.properties)) {
                    if (!description.includes(field)) problems.push(`${key}: row field ${field} is not described`);
                }
            }
        }
        assert.deepEqual(problems, []);
    });
}

test('README: the English and Italian tables agree row by row (type, default, limits)', () => {
    const en = tableAfter(english, '#### Configuration parameters').map((row) => row.slice(0, 4).map(strip).join('|'));
    const it = tableAfter(italian, '#### Parametri di configurazione').map((row) => row.slice(0, 4).map(strip).join('|'));
    const norm = (row) => row.replace('required', 'obbligatorio').replace('obbligatorio', 'required');
    assert.deepEqual(it.map(norm), en.map(norm));
});

test('README: both halves have the same sections and the same code blocks', () => {
    assert.equal(headings(english, 3).length, headings(italian, 3).length, 'sections (###)');
    assert.equal(headings(english, 4).length, headings(italian, 4).length, 'subsections (####)');
    // Shell and ACL comments are prose: they may be translated.
    const withoutComments = (blocks) => blocks.map((block) => block.replace(/\s+#.*$/gm, ''));
    assert.deepEqual(withoutComments(codeBlocks(italian)), withoutComments(codeBlocks(english)));
    // Every table has a twin: same number of rows.
    const tableRows = (text) => text.split('\n').filter((line) => /^\|.*\|$/.test(line)).length;
    assert.equal(tableRows(italian), tableRows(english));
});

test('README: links and anchors resolve', () => {
    assert.deepEqual(linkProblems(readme, root, 'README.md'), []);
});

test('README: promises the code does not keep are gone', () => {
    const banned = [
        [/Sentry/i, 'Sentry'],
        [/Anonymous error reporting|Segnalazione anonima/i, 'telemetry description'],
        [/debug-thermostat-routing/, 'untracked script'],
        [/Planned for v1\.2\.0|Pianificato per v1\.2\.0/, 'stale roadmap'],
        [/Required parameters|manual dispatch/i, 'stale statements'],
        [/renegotiation[^.\n]*Node(?:\.js)? 24|Node(?:\.js)? 24[^.\n]*renegotiation/i, 'renegotiation tied to Node 24'],
        [/Control\*\*: On\/Off/, 'lights described as on/off only'],
        [/PINs? (?:are |already )?masked!/i, 'PIN-only masking claim'],
    ];
    for (const [pattern, what] of banned) assert.doesNotMatch(readme, pattern, what);
    // "telemetry" may only appear to say it is gone.
    for (const line of readme.split('\n').filter((l) => /telemetr/i.test(l))) {
        assert.match(line, /No telemetry|Nessuna telemetria|no telemetry|nessuna telemetria|`telemetry` (?:key|setting|setting is)|chiave `telemetry`|`telemetry`/i, line);
    }
});

test('README: states the supported runtimes the project is tested on', () => {
    for (const half of [english, italian]) {
        assert.match(half, /Node(?:\.js)? 22\.12/);
        assert.match(half, /Node 22, 24 (?:and|e) 26/);
        assert.match(half, /2\.5\.x/);
        assert.match(half, /2\.4\.x/);
        assert.match(half, /1\.x/);
        assert.match(half, /149/);
    }
});
