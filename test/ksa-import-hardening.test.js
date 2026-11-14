const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { KsaImportService } = require('../dist/platform/ksa-import-service.js');
const { PlatformConfigFileService } = require('../dist/platform/config-file-service.js');
const { resolveRuntimeConfig } = require('../dist/platform/runtime-config.js');
const { parseKsaProgramFromBuffer, MAX_KSA_FILE_BYTES } = require('../dist/ksa/parser.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

function recordingLog() {
    const lines = [];
    const add = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
    return { lines, info: add('INFO'), warn: add('WARN'), error: add('ERROR'), debug: add('DEBUG') };
}

function ksaFile(dir, data) {
    const file = path.join(dir, 'panel.ksa');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('KSFS\x03\x00'), Buffer.from(JSON.stringify({ INFO: {}, DATA: data }))]));
    return file;
}

const PANEL_WITH_THERMOSTAT = {
    PRG_OUTPUTS: [{ ID: '18', DES: 'Heating A', CAT: 'THERMO' }, { ID: '20', DES: 'Heating B', CAT: 'THERMO' }],
    PRG_THERMOSTATS: [
        { ID: '3', HEATING_OUT: '18', PERIPH: { PID: '2' } },
        { ID: '5', HEATING_OUT: '20', PERIPH: { PID: '6' } },
    ],
};

function setup(t, { platformBlock = {}, data = PANEL_WITH_THERMOSTAT, log = recordingLog(), fileSystem } = {}) {
    const dir = tmpStorage(t, 'klares4-ksa-hard-');
    const ksaPath = ksaFile(dir, data);
    const block = {
        platform: 'Lares4Complete',
        name: 'Klares4',
        ip: '192.0.2.10',
        pin: '000000',
        ...platformBlock,
        ksaImport: { enabled: true, filePath: ksaPath, applyAtStartup: true, ...(platformBlock.ksaImport ?? {}) },
    };
    fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify({ platforms: [block] }, null, 4)}\n`);
    const runtime = JSON.parse(JSON.stringify(block));
    const service = new KsaImportService(log, dir, new PlatformConfigFileService(log, dir, fileSystem));
    const persisted = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).platforms[0];
    return { dir, ksaPath, runtime, service, persisted, log };
}

const userDomus = () => ({
    enabled: true,
    manualPairs: [{ thermostatOutputId: '18', domusSensorId: '7' }, { thermostatOutputId: '19', domusSensorId: '8' }],
    manualCommandPairs: [{ thermostatOutputId: '18', commandThermostatId: '9' }, { thermostatOutputId: '19', commandThermostatId: '4' }],
});

test('PLAT-03: the thermostat pairs of the user win over the backup, at runtime and on disk; missing ones are added', async (t) => {
    const { runtime, service, persisted, log } = setup(t, { platformBlock: { domusThermostat: userDomus() } });
    await service.prepare(runtime, 'Lares4Complete');

    for (const domus of [runtime.domusThermostat, persisted().domusThermostat]) {
        assert.deepEqual(domus.manualCommandPairs, [
            { thermostatOutputId: '18', commandThermostatId: '9' },
            { thermostatOutputId: '19', commandThermostatId: '4' },
            { thermostatOutputId: '20', commandThermostatId: '5' },
        ]);
        assert.deepEqual(domus.manualPairs, [
            { thermostatOutputId: '18', domusSensorId: '7' },
            { thermostatOutputId: '19', domusSensorId: '8' },
            { thermostatOutputId: '20', domusSensorId: '6' },
        ]);
        assert.equal(domus.enabled, true);
    }
    const infos = log.lines.filter((line) => line.startsWith('INFO') && /manualCommandPairs|manualPairs/.test(line));
    assert.ok(infos.some((line) => /thermostat_18/.test(line) && /9/.test(line) && /3/.test(line)), infos.join('\n'));
});

test('PLAT-03: a backup without thermostats never empties the lists of the user', async (t) => {
    const { runtime, service, persisted } = setup(t, {
        platformBlock: { domusThermostat: userDomus() },
        data: { PRG_OUTPUTS: [{ ID: '18', DES: 'Heating A', CAT: 'THERMO' }] },
    });
    await service.prepare(runtime, 'Lares4Complete');

    for (const domus of [runtime.domusThermostat, persisted().domusThermostat]) {
        assert.deepEqual(domus.manualCommandPairs, userDomus().manualCommandPairs);
        assert.deepEqual(domus.manualPairs, userDomus().manualPairs);
    }
});

test('PLAT-03: a pair written as thermostat_<id> is the same thermostat as the backup bare id', async (t) => {
    const { runtime, service } = setup(t, {
        platformBlock: { domusThermostat: { manualCommandPairs: [{ thermostatOutputId: 'thermostat_18', commandThermostatId: '9' }] } },
    });
    await service.prepare(runtime, 'Lares4Complete');

    assert.deepEqual(runtime.domusThermostat.manualCommandPairs, [
        { thermostatOutputId: 'thermostat_18', commandThermostatId: '9' },
        { thermostatOutputId: '20', commandThermostatId: '5' },
    ]);
});

test('PLAT-03: the pairs reach the runtime config the platform reads back after the import', async (t) => {
    const { runtime, service, log } = setup(t, { platformBlock: { domusThermostat: userDomus() } });
    await service.prepare(runtime, 'Lares4Complete');

    const reread = resolveRuntimeConfig(runtime, log);
    assert.deepEqual(
        reread.domusThermostat.manualCommandPairs.map((pair) => `${pair.thermostatOutputId}>${pair.commandThermostatId}`),
        ['18>9', '19>4', '20>5'],
    );
});

test('PLAT-03: without any user pair the backup pairs are used, as before', async (t) => {
    const { runtime, service } = setup(t, {});
    await service.prepare(runtime, 'Lares4Complete');
    assert.deepEqual(runtime.domusThermostat.manualCommandPairs, [
        { thermostatOutputId: '18', commandThermostatId: '3' },
        { thermostatOutputId: '20', commandThermostatId: '5' },
    ]);
});

const HOSTILE = {
    PRG_OUTPUTS: [
        { ID: '__proto__', DES: 'polluted', CAT: 'LIGHT' }, { ID: 'constructor', DES: 'ctor' },
        { ID: '5/../../x', DES: 'A'.repeat(300) }, { ID: 7, DES: 'B'.repeat(300), CAT: 'LIGHT' }, { ID: '-1', DES: 'neg' }, null, 5,
    ],
    PRG_ZONES: [{ ID: '1', DES: 'Zone #+/ odd' }],
    PRG_SCENARIOS: [{ ID: '1', DES: 'Scene' }],
    PRG_BUS_HAS: [{ ID: '1', DOMUS: 'str' }],
    PRG_THERMOSTATS: [
        { ID: '__proto__', HEATING_OUT: '18' },
        { ID: '3', HEATING_OUT: '__proto__', COOLING_OUT: 'constructor', PERIPH: { PID: { evil: 1 } } },
        { ID: '4', HEATING_OUT: '21', PERIPH: { PID: 'x y' } },
    ],
    PRG_ROOMS: [{ ID: '1', DES: '../../etc #+/' }, { ID: '__proto__', DES: 'p' }],
    PRG_MAPS: [
        { ROOM: '1', OT: 'prgZones', OID: '../#' }, { ROOM: '__proto__', OT: 'prgZones', OID: '2' },
        { ROOM: '1', OT: 'prgOutputs', OID: '__proto__' }, { ROOM: '1', OT: 'prgZones', OID: '1' }, { ROOM: '1', OT: 'prgOutputs', OID: '7' },
    ],
};

const CUSTOM_NAME_ID = /^(zone|light|cover|gate|thermostat|output|scenario)_[0-9]+$|^sensor_((temp|hum|light)_)?[0-9]+$/;
const ROOM_DEVICE_ID = /^(light_|cover_|gate_|zone_|thermostat_|scenario_)[0-9]+$|^sensor_(temp|hum|light)_[0-9]+$/;

test('PLAT-17: ids and names from an untrusted .ksa follow the schema patterns before reaching config.json', async (t) => {
    const { runtime, service, persisted } = setup(t, {
        data: HOSTILE,
        platformBlock: { ksaImport: { applyCustomNames: true } },
    });
    await service.prepare(runtime, 'Lares4Complete');
    const saved = persisted();

    assert.ok(saved.customNames.length > 0);
    for (const row of saved.customNames) {
        assert.match(row.deviceId, CUSTOM_NAME_ID);
        assert.ok(row.name.length <= 64, `name of ${row.deviceId} is ${row.name.length} long`);
    }
    for (const room of saved.roomMapping.rooms) {
        assert.match(room.roomName, /^[a-z0-9_]+$/);
        for (const device of room.devices) assert.match(device.deviceId, ROOM_DEVICE_ID);
    }
    const pairs = [...(saved.domusThermostat.manualPairs ?? []), ...(saved.domusThermostat.manualCommandPairs ?? [])];
    assert.ok(pairs.length > 0);
    for (const pair of pairs) {
        for (const value of Object.values(pair)) assert.match(value, /^[0-9]+$/);
    }
    assert.equal(({}).polluted, undefined);
    assert.deepEqual(
        saved.customNames.filter((row) => /proto|constructor|\.\./.test(row.deviceId)),
        [],
    );
    // The legitimate numeric entries survive.
    assert.ok(saved.customNames.some((row) => row.deviceId === 'output_7'));
    assert.ok(saved.customNames.some((row) => row.deviceId === 'zone_1'));
});

test('PLAT-17: a .ksa over the size limit is refused with a clear message, without being read', async (t) => {
    const { runtime, service, ksaPath, log } = setup(t, {});
    fs.truncateSync(ksaPath, MAX_KSA_FILE_BYTES + 1); // sparse: costs nothing
    const reads = [];
    const original = fs.promises.readFile;
    fs.promises.readFile = async (file, ...rest) => {
        reads.push(file);
        return original(file, ...rest);
    };
    t.after(() => { fs.promises.readFile = original; });

    await service.prepare(runtime, 'Lares4Complete');

    assert.ok(!reads.includes(ksaPath), 'the oversized file was read');
    const errors = log.lines.filter((line) => line.startsWith('ERROR'));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /KSA import failed/);
    assert.match(errors[0], /32 MB/);
    assert.equal(runtime.domusThermostat, undefined);
});

test('PLAT-17: the parser itself refuses a buffer over the limit', () => {
    assert.throws(() => parseKsaProgramFromBuffer(Buffer.alloc(MAX_KSA_FILE_BYTES + 1)), /32 MB/);
});

test('PLAT-17: applyExclusionSuggestions is accepted, ignored, and said so in one line; exclusions stay as written', async (t) => {
    const { runtime, service, persisted, log } = setup(t, {
        platformBlock: { excludeOutputs: ['5'], excludeZones: ['7'], ksaImport: { applyExclusionSuggestions: true } },
    });
    await service.prepare(runtime, 'Lares4Complete');

    const infos = log.lines.filter((line) => line.startsWith('INFO') && /applyExclusionSuggestions/.test(line));
    assert.equal(infos.length, 1);
    assert.match(infos[0], /ignored/);
    for (const config of [runtime, persisted()]) {
        assert.deepEqual(config.excludeOutputs, ['5']);
        assert.deepEqual(config.excludeZones, ['7']);
        assert.equal(config.excludeSensors, undefined);
    }
    const { runtime: quiet, service: quietService, log: quietLog } = setup(t, {});
    await quietService.prepare(quiet, 'Lares4Complete');
    assert.ok(!quietLog.lines.some((line) => /applyExclusionSuggestions/.test(line)));
});

test('PLAT-07: a failed write of config.json is not reported as applied, and the import stays pending', async (t) => {
    const failing = { open: async () => { throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); } };
    const { runtime, service, persisted, log } = setup(t, { fileSystem: failing });
    const before = persisted();
    await service.prepare(runtime, 'Lares4Complete');

    assert.ok(!log.lines.some((line) => /applied to config.json/.test(line)), log.lines.join('\n'));
    assert.ok(log.lines.some((line) => line.startsWith('WARN') && /could not be saved to config.json/.test(line)));
    assert.equal(runtime.ksaImport.applyAtStartup, true);
    assert.deepEqual(persisted(), before);
});

test('PLAT-07: a successful write is reported and resets applyAtStartup in memory and on disk', async (t) => {
    const { runtime, service, persisted, log } = setup(t, {});
    await service.prepare(runtime, 'Lares4Complete');

    assert.ok(log.lines.some((line) => line.startsWith('INFO') && /applied to config.json/.test(line)));
    assert.equal(runtime.ksaImport.applyAtStartup, false);
    assert.equal(persisted().ksaImport.applyAtStartup, false);
});

test('PLAT-07: with two platform blocks the import is saved in the block of this instance', async (t) => {
    const { dir, runtime, service } = setup(t, {});
    const file = path.join(dir, 'config.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const other = { platform: 'Lares4Complete', name: 'Other house', ip: '192.0.2.99', ksaImport: { enabled: false } };
    stored.platforms.unshift(other);
    fs.writeFileSync(file, JSON.stringify(stored, null, 4));

    await service.prepare(runtime, 'Lares4Complete');

    const after = JSON.parse(fs.readFileSync(file, 'utf8')).platforms;
    assert.deepEqual(after[0], other);
    assert.equal(after[1].ksaImport.applyAtStartup, false);
    assert.ok(after[1].domusThermostat.manualCommandPairs.length > 0);
});
