const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    writeFileAtomic,
    writeFileAtomicSync,
    writeJsonAtomic,
    removeOrphanedTemporaryFiles,
} = require('../dist/atomic-file.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const mode = (file) => fs.statSync(file).mode & 0o777;

function errno(code) {
    return Object.assign(new Error(`${code}: simulated`), { code });
}

test('PLAT-16: a file created for the first time is private (0600), whatever the umask', async (t) => {
    const dir = tmpStorage(t, 'klares4-atomic-');
    const previous = process.umask(0o022);
    t.after(() => process.umask(previous));

    await writeFileAtomic(path.join(dir, 'async.json'), '{}');
    writeFileAtomicSync(path.join(dir, 'sync.json'), '{}');
    await writeJsonAtomic(path.join(dir, 'json.json'), { a: 1 });

    for (const name of ['async.json', 'sync.json', 'json.json']) assert.equal(mode(path.join(dir, name)), 0o600, name);
});

test('PLAT-16: an explicit mode wins and an existing file keeps its own', async (t) => {
    const dir = tmpStorage(t, 'klares4-atomic-');
    const explicit = path.join(dir, 'explicit.json');
    await writeFileAtomic(explicit, '{}', { mode: 0o640 });
    assert.equal(mode(explicit), 0o640);

    const existing = path.join(dir, 'existing.json');
    fs.writeFileSync(existing, 'old', { mode: 0o644 });
    fs.chmodSync(existing, 0o644);
    await writeFileAtomic(existing, 'new');
    assert.equal(mode(existing), 0o644);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'new');
});

test('PLAT-16: the temporary file is created exclusively and never follows a planted symlink', async (t) => {
    const dir = tmpStorage(t, 'klares4-atomic-');
    const victim = path.join(dir, 'victim.txt');
    fs.writeFileSync(victim, 'untouched');
    const seen = [];
    const fileSystem = {
        open: async (target, flags, fileMode) => {
            seen.push({ target, flags });
            // The first name an attacker could have guessed is already taken by a link.
            if (seen.length === 1 && flags === 'wx') fs.symlinkSync(victim, target);
            return fs.promises.open(target, flags, fileMode);
        },
    };
    await writeFileAtomic(path.join(dir, 'state.json'), 'data', { fileSystem });

    const temporaryOpens = seen.filter((entry) => entry.target.endsWith('.tmp'));
    assert.ok(temporaryOpens.length >= 2, 'a taken name is retried with another one');
    assert.ok(temporaryOpens.every((entry) => entry.flags === 'wx'));
    assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), 'data');
    fs.rmSync(temporaryOpens[0].target, { force: true });
});

test('PLAT-16: temporary names are unpredictable', async (t) => {
    const dir = tmpStorage(t, 'klares4-atomic-');
    const names = new Set();
    const fileSystem = {
        open: async (target, flags, fileMode) => {
            if (flags === 'wx') names.add(path.basename(target));
            return fs.promises.open(target, flags, fileMode);
        },
    };
    for (let i = 0; i < 5; i += 1) await writeFileAtomic(path.join(dir, 'a.json'), String(i), { fileSystem });
    assert.equal(names.size, 5);
    for (const name of names) assert.match(name, /^a\.json\.\d+\.[0-9a-f]{12}\.tmp$/);
});

test('PLAT-07: a symlinked target keeps the link and the destination is replaced', async (t) => {
    const dir = tmpStorage(t, 'klares4-atomic-');
    const realDir = tmpStorage(t, 'klares4-atomic-real-');
    const destination = path.join(realDir, 'config-real.json');
    fs.writeFileSync(destination, 'old', { mode: 0o640 });
    fs.chmodSync(destination, 0o640);
    const link = path.join(dir, 'config.json');
    fs.symlinkSync(destination, link);

    const result = await writeFileAtomic(link, 'new');

    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'new');
    assert.equal(mode(destination), 0o640);
    assert.equal(result.path, fs.realpathSync(destination));
    assert.deepEqual(fs.readdirSync(realDir), ['config-real.json']);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);

    writeFileAtomicSync(link, 'newer');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'newer');
});

test('PLAT-07: the caller learns how the file was written', async (t) => {
    const dir = tmpStorage(t, 'klares4-atomic-');
    const result = await writeFileAtomic(path.join(dir, 'a.json'), '{}');
    assert.equal(result.method, 'rename');
    assert.equal(writeFileAtomicSync(path.join(dir, 'b.json'), '{}').method, 'rename');
});

for (const code of ['EBUSY', 'EXDEV']) {
    test(`PLAT-07: when rename fails with ${code} the write falls back in place and says so`, async (t) => {
        const dir = tmpStorage(t, 'klares4-atomic-');
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, 'old', { mode: 0o600 });
        const reasons = [];
        const result = await writeFileAtomic(file, 'new', {
            fileSystem: { rename: async () => { throw errno(code); } },
            onInPlaceFallback: (reason) => reasons.push(reason.code),
        });

        assert.equal(result.method, 'in-place');
        assert.deepEqual(reasons, [code]);
        assert.equal(fs.readFileSync(file, 'utf8'), 'new');
        assert.deepEqual(fs.readdirSync(dir), ['config.json'], 'the temporary file is removed');
    });
}

test('PLAT-07: when the temporary file cannot be created (EACCES) the write falls back in place', async (t) => {
    const dir = tmpStorage(t, 'klares4-atomic-');
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, 'old');
    const reasons = [];
    const result = await writeFileAtomic(file, 'new', {
        fileSystem: {
            open: async (target, flags, fileMode) => {
                if (flags === 'wx') throw errno('EACCES');
                return fs.promises.open(target, flags, fileMode);
            },
        },
        onInPlaceFallback: (reason) => reasons.push(reason.code),
    });
    assert.equal(result.method, 'in-place');
    assert.deepEqual(reasons, ['EACCES']);
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

test('PLAT-07: without consent to the fallback, the error is thrown and the file is untouched', async (t) => {
    const dir = tmpStorage(t, 'klares4-atomic-');
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, 'old');
    await assert.rejects(
        writeFileAtomic(file, 'new', { fileSystem: { rename: async () => { throw errno('EBUSY'); } } }),
        { code: 'EBUSY' },
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('PLAT-07: other failures are never papered over by the fallback', async (t) => {
    const dir = tmpStorage(t, 'klares4-atomic-');
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, 'old');
    let fellBack = false;
    await assert.rejects(
        writeFileAtomic(file, 'new', {
            fileSystem: { rename: async () => { throw errno('ENOSPC'); } },
            onInPlaceFallback: () => { fellBack = true; },
        }),
        { code: 'ENOSPC' },
    );
    assert.equal(fellBack, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('PLAT-16: stale temporary files of the plugin are removed at startup, fresh ones and strangers are not', async (t) => {
    const dir = tmpStorage(t, 'klares4-atomic-');
    const stale = ['config.json.4242.0a1b2c3d4e5f.tmp', 'klares4-ksa-cache.json.17.3.tmp', 'klares4-matter-names.json.9.ffffffffffff.tmp'];
    const fresh = 'config.json.4243.abcdefabcdef.tmp';
    const strangers = ['notes.tmp', 'config.json', 'other.json.1.2.tmp', 'klares4-devices.json'];
    for (const name of [...stale, fresh, ...strangers]) fs.writeFileSync(path.join(dir, name), 'x');
    const now = Date.now();
    const old = new Date(now - 10 * 60 * 1000);
    for (const name of stale) fs.utimesSync(path.join(dir, name), old, old);
    fs.utimesSync(path.join(dir, 'other.json.1.2.tmp'), old, old);

    const removed = await removeOrphanedTemporaryFiles(dir, { now: () => now });

    assert.deepEqual(removed.sort(), [...stale].sort());
    assert.deepEqual(fs.readdirSync(dir).sort(), [fresh, ...strangers].sort());
});

test('PLAT-16: cleaning a missing directory is a no-op', async () => {
    assert.deepEqual(await removeOrphanedTemporaryFiles(path.join(require('node:os').tmpdir(), 'klares4-does-not-exist-xyz')), []);
});
