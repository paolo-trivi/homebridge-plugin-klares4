'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkEntries } = require('../scripts/check-pack.js');

const PKG = { name: 'homebridge-plugin-klares4', main: 'dist/index.js', scripts: { build: 'tsc' } };
const GOOD = [
    'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'config.schema.json',
    'dist/index.js', 'dist/index.d.ts', 'dist/platform/index.js', 'dist/platform/index.d.ts',
];

test('a package with the runtime, declarations and the documented root files passes', () => {
    assert.deepEqual(checkEntries(GOOD, PKG), []);
});

test('source maps are refused, whatever they point at', () => {
    const problems = checkEntries([...GOOD, 'dist/index.js.map', 'dist/index.d.ts.map'], PKG);
    assert.deepEqual(problems, [
        'source map in the package: dist/index.js.map',
        'source map in the package: dist/index.d.ts.map',
    ]);
});

test('files outside dist and the documented root files are refused', () => {
    const problems = checkEntries([...GOOD, 'src/index.ts', 'test/x.test.js', '.env', 'config.json'], PKG);
    assert.deepEqual(problems.map((p) => p.replace('unexpected file in the package: ', '')), [
        'src/index.ts', 'test/x.test.js', '.env', 'config.json',
    ]);
});

test('a missing entry point or declaration is reported', () => {
    const entries = GOOD.filter((e) => e !== 'dist/index.js' && e !== 'LICENSE');
    assert.deepEqual(checkEntries(entries, PKG).sort(), [
        'missing from the package: LICENSE',
        'missing from the package: dist/index.js',
    ]);
});

test('install-time lifecycle scripts are refused', () => {
    const problems = checkEntries(GOOD, { ...PKG, scripts: { postinstall: 'node x.js', prepack: 'tsc' } });
    assert.deepEqual(problems, ['package.json defines the install-time script "postinstall"']);
});

test('dist files without a source file are reported as stale output', () => {
    const { orphanedDistEntries } = require('../scripts/check-pack.js');
    const sources = new Set(['index.ts', 'platform/index.ts']);
    const entries = [
        'dist/index.js', 'dist/index.d.ts', 'dist/platform/index.js', 'dist/platform/index.d.ts',
        'dist/telemetry.js', 'dist/telemetry.d.ts', 'package.json',
    ];
    assert.deepEqual(orphanedDistEntries(entries, (rel) => sources.has(rel)), ['dist/telemetry.js', 'dist/telemetry.d.ts']);
});
