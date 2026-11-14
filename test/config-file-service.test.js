const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PlatformConfigFileService } = require('../dist/platform/config-file-service.js');

const log = { info() {}, warn() {}, error() {}, debug() {} };

function makeStorage(config) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-config-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify(config, null, 4)}\n`, 'utf8');
    return { dir, file };
}

function sampleConfig(platform) {
    return {
        bridge: { name: 'Homebridge', username: '0E:00:00:00:00:01', port: 51826, pin: '000-00-000' },
        accessories: [],
        platforms: [
            { platform: 'config', name: 'Config' },
            { platform, name: 'Klares4', ip: '192.0.2.10', pin: '000000', generateDebugFile: true, excludeZones: ['1'] },
        ],
    };
}

test('F17: a rewrite keeps Homebridge formatting (4-space indent, trailing newline)', async () => {
    const { file, dir } = makeStorage(sampleConfig('Lares4Complete'));
    await new PlatformConfigFileService(log, dir).disableDebugFlag('Lares4Complete');

    const expected = sampleConfig('Lares4Complete');
    expected.platforms[1].generateDebugFile = false;
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(expected, null, 4)}\n`);
});

test('F17: the fully qualified platform name is matched too', async () => {
    const { file, dir } = makeStorage(sampleConfig('homebridge-plugin-klares4.Lares4Complete'));
    await new PlatformConfigFileService(log, dir).disableDebugFlag('Lares4Complete');

    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.platforms[1].generateDebugFile, false);
    assert.equal(written.platforms[1].platform, 'homebridge-plugin-klares4.Lares4Complete');
});

test('F17: config.json is replaced by rename, keeps its mode and leaves no temp file', async () => {
    const { file, dir } = makeStorage(sampleConfig('Lares4Complete'));
    fs.chmodSync(file, 0o600);
    const renames = [];
    const originalRename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
        renames.push([from, to]);
        return originalRename(from, to);
    };
    try {
        await new PlatformConfigFileService(log, dir).disableDebugFlag('Lares4Complete');
    } finally {
        fs.promises.rename = originalRename;
    }

    assert.equal(renames.length, 1);
    assert.equal(renames[0][1], file);
    assert.equal(path.dirname(renames[0][0]), dir);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('F17: a failing serialization leaves config.json untouched', async () => {
    const { file, dir } = makeStorage(sampleConfig('Lares4Complete'));
    const before = fs.readFileSync(file, 'utf8');
    const errors = [];
    const service = new PlatformConfigFileService({ ...log, error: (...args) => errors.push(args.join(' ')) }, dir);
    await service.updatePlatformConfig('Lares4Complete', (platformConfig) => {
        platformConfig.broken = 10n; // JSON.stringify throws on BigInt
        return true;
    });

    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
    assert.equal(errors.length, 1);
});

test('F17: concurrent updates are serialized and none is lost', async () => {
    const { file, dir } = makeStorage(sampleConfig('Lares4Complete'));
    const service = new PlatformConfigFileService(log, dir);
    await Promise.all([
        service.updatePlatformConfig('Lares4Complete', (c) => { c.first = true; return true; }),
        service.updatePlatformConfig('Lares4Complete', (c) => { c.second = true; return true; }),
    ]);
    const written = JSON.parse(fs.readFileSync(file, 'utf8')).platforms[1];
    assert.equal(written.first, true);
    assert.equal(written.second, true);
});
