'use strict';

// The line gate counts lines, not line terminators: a file of exactly the
// limit, ending with a newline as every file does, is within the limit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tmpStorage } = require('./fixtures/tmp-storage.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-max-lines.js');

function run(dir, limit) {
    return spawnSync(process.execPath, [SCRIPT, 'src', String(limit)], { cwd: dir, encoding: 'utf8' });
}

function project(t, files) {
    const dir = tmpStorage(t, 'klares4-max-lines-');
    fs.mkdirSync(path.join(dir, 'src'));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'src', name), content);
    return dir;
}

const lines = (count) => Array.from({ length: count }, (_, index) => `const line${index} = ${index};`).join('\n');

test('a file of exactly the limit passes, with or without a final newline, also with CRLF', (t) => {
    const dir = project(t, {
        'unix.ts': `${lines(10)}\n`,
        'bare.ts': lines(10),
        'windows.ts': `${lines(10).replace(/\n/g, '\r\n')}\r\n`,
    });
    const result = run(dir, 10);
    assert.equal(result.status, 0, result.stderr);
});

test('one line over the limit fails and names the file with its real line count', (t) => {
    const dir = project(t, { 'long.ts': `${lines(11)}\n`, 'fine.ts': `${lines(3)}\n`, 'types.d.ts': `${lines(50)}\n` });
    const result = run(dir, 10);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Found 1 files exceeding 10 lines/);
    assert.match(result.stderr, /long\.ts: 11/);
});
