'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planTestRuns, listTestFiles, HARNESS, TEST_DIR } = require('../scripts/run-tests.js');

function memoryIo(sources) {
    return {
        readFile: (file) => sources[file],
        isFile: (file) => Object.hasOwn(sources, file),
    };
}

const dir = path.join(TEST_DIR, 'unit');
const at = (name) => path.join(dir, name);

test('a file that reaches the real Matter stack harness, directly or through a fixture, is a real-stack file', () => {
    const io = memoryIo({
        [HARNESS]: 'module.exports = {};',
        [at('direct.test.js')]: "const h = require('../fixtures/real-matter-stack.js');",
        [at('no-ext.test.js')]: "const h = require('../fixtures/real-matter-stack');",
        [at('dynamic.test.js')]: "const h = await import('../fixtures/real-matter-stack.js');",
        [at('indirect.test.js')]: "const w = require('./wrapper');",
        [at('wrapper.js')]: "module.exports = require('../fixtures/real-matter-stack.js');",
        [at('plain.test.js')]: "const w = require('node:fs'); const x = require('./plain-helper');",
        [at('plain-helper.js')]: "module.exports = require('./plain.test.js');",
    });
    const files = ['direct', 'no-ext', 'dynamic', 'indirect', 'plain'].map((n) => at(`${n}.test.js`));
    const plan = planTestRuns(files, io);
    assert.deepEqual(plan.realStack.map((f) => path.basename(f)),
        ['direct.test.js', 'no-ext.test.js', 'dynamic.test.js', 'indirect.test.js']);
    assert.deepEqual(plan.light.map((f) => path.basename(f)), ['plain.test.js']);
});

test('a cycle of local requires terminates', () => {
    const io = memoryIo({
        [at('a.test.js')]: "require('./b');",
        [at('b.js')]: "require('./a.test.js');",
    });
    assert.deepEqual(planTestRuns([at('a.test.js')], io), { light: [at('a.test.js')], realStack: [] });
});

// Independent of the parser in the runner: what a test file CALLS. The harness
// exports a session helper and a start function (see HARNESS_API); any test file
// that uses either (itself or through a local helper that does) must be classified as a
// real-stack file, and no file may be classified as one without using them. A way
// of loading the harness that the runner does not follow (a computed path, say)
// shows up here as a mismatch. The names are built in pieces so that this file is
// not itself taken for a user of the harness.
const HARNESS_API = new RegExp(['realMatter' + 'StackSession', 'startRealMatter' + 'Stack'].join('|'));

test('the runner classifies exactly the test files that use the real stack harness', () => {
    const files = listTestFiles(TEST_DIR);
    const helpers = fs.readdirSync(path.join(TEST_DIR, 'fixtures'))
        .filter((name) => name.endsWith('.js'))
        .map((name) => path.join(TEST_DIR, 'fixtures', name))
        .filter((file) => file !== HARNESS && HARNESS_API.test(fs.readFileSync(file, 'utf8')));
    const usesHarness = (file) => {
        const text = fs.readFileSync(file, 'utf8');
        return HARNESS_API.test(text) || helpers.some((h) => text.includes(path.basename(h, '.js')));
    };
    const expected = files.filter(usesHarness);
    const { realStack, light } = planTestRuns(files);
    assert.deepEqual(realStack, expected, 'real-stack files the runner found differ from the files that call the harness');
    assert.equal(realStack.length + light.length, files.length);
    assert.ok(realStack.length >= 9, 'the known real-stack files are found');
});
