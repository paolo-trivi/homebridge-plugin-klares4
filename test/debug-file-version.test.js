const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DebugFileGenerator } = require('../dist/debug-capture/file-generator.js');

test('F40: the debug file reports the running plugin version', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-debugfile-'));
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    new DebugFileGenerator(log, dir).generate([], [], 10000);
    let data;
    for (let i = 0; i < 100 && !data; i++) {
        await new Promise((r) => setTimeout(r, 20)); // the file is written asynchronously
        const file = fs.readdirSync(dir).find((f) => f.startsWith('klares4-debug-'));
        try { data = file && JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { /* still writing */ }
    }
    assert.equal(data.version, require('../package.json').version);
});
