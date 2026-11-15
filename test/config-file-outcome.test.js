const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PlatformConfigFileService } = require('../dist/platform/config-file-service.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

function recordingLog() {
    const lines = [];
    const add = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
    return { lines, info: add('INFO'), warn: add('WARN'), error: add('ERROR'), debug() {} };
}

function write(dir, config) {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify(config, null, 4)}\n`);
    return file;
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function twoBlocks() {
    return {
        platforms: [
            { platform: 'Lares4Complete', name: 'House A', ip: '192.0.2.1', generateDebugFile: true },
            { platform: 'Lares4Complete', name: 'House B', ip: '192.0.2.2', generateDebugFile: true },
        ],
    };
}

test('PLAT-07: config.json that is a symlink stays a symlink and its destination is updated', async (t) => {
    const dir = tmpStorage(t, 'klares4-cfg-');
    const realDir = tmpStorage(t, 'klares4-cfg-real-');
    const destination = write(realDir, { platforms: [{ platform: 'Lares4Complete', generateDebugFile: true }] });
    fs.chmodSync(destination, 0o600);
    fs.symlinkSync(destination, path.join(dir, 'config.json'));

    const log = recordingLog();
    const outcome = await new PlatformConfigFileService(log, dir).disableDebugFlag('Lares4Complete');

    assert.equal(outcome.status, 'written');
    assert.equal(fs.lstatSync(path.join(dir, 'config.json')).isSymbolicLink(), true);
    assert.equal(read(destination).platforms[0].generateDebugFile, false);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
});

test('PLAT-07: with two blocks the one named by the selector is updated, not the first', async (t) => {
    const dir = tmpStorage(t, 'klares4-cfg-');
    const file = write(dir, twoBlocks());
    const outcome = await new PlatformConfigFileService(recordingLog(), dir)
        .disableDebugFlag('Lares4Complete', { name: 'House B', ip: '192.0.2.2' });

    assert.equal(outcome.status, 'written');
    const blocks = read(file).platforms;
    assert.equal(blocks[0].generateDebugFile, true);
    assert.equal(blocks[1].generateDebugFile, false);
});

test('PLAT-07: two blocks with the same name are told apart by ip', async (t) => {
    const dir = tmpStorage(t, 'klares4-cfg-');
    const config = twoBlocks();
    config.platforms[1].name = 'House A';
    const file = write(dir, config);
    await new PlatformConfigFileService(recordingLog(), dir)
        .disableDebugFlag('Lares4Complete', { name: 'House A', ip: ' 192.0.2.2 ' });

    const blocks = read(file).platforms;
    assert.equal(blocks[0].generateDebugFile, true);
    assert.equal(blocks[1].generateDebugFile, false);
});

test('PLAT-07: with two blocks and no way to tell them apart nothing is written and the caller is told', async (t) => {
    const dir = tmpStorage(t, 'klares4-cfg-');
    const file = write(dir, twoBlocks());
    const before = fs.readFileSync(file, 'utf8');
    const log = recordingLog();
    const service = new PlatformConfigFileService(log, dir);

    for (const selector of [undefined, { name: 'Elsewhere', ip: '198.51.100.9' }]) {
        const outcome = await service.disableDebugFlag('Lares4Complete', selector);
        assert.equal(outcome.status, 'ambiguous');
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(log.lines.some((line) => line.startsWith('WARN') && /2 "Lares4Complete" blocks/.test(line)));
    assert.ok(!log.lines.some((line) => /Debug flag disabled/.test(line)));
});

test('PLAT-07: no platform block is reported, not silently ignored', async (t) => {
    const dir = tmpStorage(t, 'klares4-cfg-');
    write(dir, { platforms: [{ platform: 'Other' }] });
    const outcome = await new PlatformConfigFileService(recordingLog(), dir)
        .updatePlatformConfig('Lares4Complete', () => true);
    assert.equal(outcome.status, 'no-platform-block');
});

test('PLAT-07: nothing to change is "unchanged", and no success is logged', async (t) => {
    const dir = tmpStorage(t, 'klares4-cfg-');
    write(dir, { platforms: [{ platform: 'Lares4Complete', generateDebugFile: false }] });
    const log = recordingLog();
    const outcome = await new PlatformConfigFileService(log, dir).disableDebugFlag('Lares4Complete');
    assert.equal(outcome.status, 'unchanged');
    assert.deepEqual(log.lines, []);
});

test('PLAT-07: a write error is returned as "failed" and no success is logged', async (t) => {
    const dir = tmpStorage(t, 'klares4-cfg-');
    const file = write(dir, { platforms: [{ platform: 'Lares4Complete', generateDebugFile: true }] });
    const before = fs.readFileSync(file, 'utf8');
    const log = recordingLog();
    const failing = { open: async () => { throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); } };

    const outcome = await new PlatformConfigFileService(log, dir, failing).disableDebugFlag('Lares4Complete');

    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error, /ENOSPC/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(log.lines.some((line) => line.startsWith('ERROR') && /Failed to update config.json/.test(line)));
    assert.ok(!log.lines.some((line) => /Debug flag disabled/.test(line)));
});

for (const code of ['EBUSY', 'EXDEV']) {
    test(`PLAT-07: rename impossible (${code}): config.json is rewritten in place and a warning says so`, async (t) => {
        const dir = tmpStorage(t, 'klares4-cfg-');
        const file = write(dir, { platforms: [{ platform: 'Lares4Complete', generateDebugFile: true }] });
        const log = recordingLog();
        const noRename = { rename: async () => { throw Object.assign(new Error(`${code}: simulated`), { code }); } };

        const outcome = await new PlatformConfigFileService(log, dir, noRename).disableDebugFlag('Lares4Complete');

        assert.deepEqual([outcome.status, outcome.method], ['written', 'in-place']);
        assert.equal(read(file).platforms[0].generateDebugFile, false);
        assert.ok(log.lines.some((line) => line.startsWith('WARN') && line.includes(code) && /in place/.test(line)));
        assert.deepEqual(fs.readdirSync(dir), ['config.json']);
    });
}

test('PLAT-16: leftover temporary files are removed when the service is asked to', async (t) => {
    const dir = tmpStorage(t, 'klares4-cfg-');
    write(dir, { platforms: [] });
    const orphan = path.join(dir, 'config.json.31337.0a1b2c3d4e5f.tmp');
    fs.writeFileSync(orphan, '{"pin":"secret"}');
    const old = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(orphan, old, old);

    await new PlatformConfigFileService(recordingLog(), dir).removeOrphanedTemporaryFiles();

    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('PLAT-R6: with a symlinked config.json the leftover temporary file next to its destination is removed too', async (t) => {
    const dir = tmpStorage(t, 'klares4-cfg-');
    const realDir = tmpStorage(t, 'klares4-cfg-real-');
    const destination = write(realDir, { platforms: [] });
    fs.symlinkSync(destination, path.join(dir, 'config.json'));
    const orphan = path.join(realDir, `${path.basename(destination)}.31337.0a1b2c3d4e5f.tmp`);
    const stranger = path.join(realDir, 'notes.txt.1.2.tmp');
    for (const file of [orphan, stranger]) {
        fs.writeFileSync(file, '{"pin":"secret"}');
        const old = new Date(Date.now() - 3600 * 1000);
        fs.utimesSync(file, old, old);
    }

    await new PlatformConfigFileService(recordingLog(), dir).removeOrphanedTemporaryFiles();

    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(stranger), true, 'files the plugin did not create are left alone');
});
