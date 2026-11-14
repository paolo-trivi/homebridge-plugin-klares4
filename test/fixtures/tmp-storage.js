'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A fresh directory under the system temp dir, removed when the test `t`
 * ends (pass or fail). Use it for every storagePath and scratch file so a run
 * leaves nothing behind.
 */
function tmpStorage(t, prefix = 'klares4-test-') {
    if (!t || typeof t.after !== 'function') {
        throw new TypeError('tmpStorage(t) needs the test context, to remove the directory when the test ends');
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

module.exports = { tmpStorage };
