'use strict';

// TD-DOC-11: ARCHITECTURE.md names every module of src/, and nothing it names is gone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const architecture = fs.readFileSync(path.join(root, 'ARCHITECTURE.md'), 'utf8');

function sourceFiles(dir, prefix = '') {
    return fs.readdirSync(path.join(root, 'src', dir), { withFileTypes: true }).flatMap((entry) => {
        const relative = path.posix.join(prefix, entry.name);
        if (entry.isDirectory()) return sourceFiles(path.join(dir, entry.name), relative);
        return entry.name.endsWith('.ts') ? [relative] : [];
    });
}

// Type declaration files are described by their directory, not file by file.
const files = sourceFiles('').filter((file) => !file.startsWith('types/'));

test('every module of src/ is named in ARCHITECTURE.md', () => {
    const missing = files.filter((file) => !architecture.includes(path.posix.basename(file)));
    assert.deepEqual(missing, []);
});

test('every module ARCHITECTURE.md names exists', () => {
    const named = [...architecture.matchAll(/`((?:[\w-]+\/)*[\w-]+\.ts)`/g)].map((match) => match[1]);
    const known = new Set(files.map((file) => path.posix.basename(file)));
    known.add('index.ts');
    const gone = named.filter((name) => !known.has(path.posix.basename(name)) && !fs.existsSync(path.join(root, 'src', name)));
    assert.deepEqual(gone, []);
});

test('ARCHITECTURE.md is current and does not mention what was removed', () => {
    assert.doesNotMatch(architecture, /delivered for `?2\.0\.0-beta\.0/);
    assert.doesNotMatch(architecture, /telemetry\.ts|sentry/i);
    assert.match(architecture, /fail closed|fail-closed/i);
    assert.match(architecture, /Truth Boundaries/);
});
