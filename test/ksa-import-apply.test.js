const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { KsaImportService } = require('../dist/platform/ksa-import-service.js');
const { PlatformConfigFileService } = require('../dist/platform/config-file-service.js');
const { mergeExclusionList } = require('../dist/platform/ksa-config-merge.js');

const log = { info() {}, warn() {}, error() {}, debug() {} };

/** Synthetic panel backup: a KSFS header followed by the embedded JSON program. */
function syntheticKsa() {
    const payload = {
        INFO: { TYPE: 'BCK' },
        DATA: {
            PRG_OUTPUTS: [
                { ID: '1', DES: 'Luce Sala Panel', CAT: 'LIGHT' },
                { ID: '2', DES: 'Luce Cucina Panel', CAT: 'LIGHT' },
            ],
            PRG_ZONES: [{ ID: '3', DES: 'Finestra Panel' }],
            PRG_SCENARIOS: [],
            PRG_BUS_HAS: [],
            PRG_THERMOSTATS: [],
            PRG_ROOMS: [{ ID: '10', DES: 'Sala / Pranzo + Ingresso #1' }, { ID: '11', DES: 'Cucina' }],
            PRG_MAPS: [
                { ROOM: '10', OT: 'prgOutputs', OID: '1' },
                { ROOM: '11', OT: 'prgOutputs', OID: '2' },
            ],
        },
    };
    return Buffer.concat([Buffer.from('KSFS\x03\x00'), Buffer.from(JSON.stringify(payload))]);
}

function setup(platformOverrides) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-ksa-apply-'));
    const ksaPath = path.join(dir, 'panel.ksa');
    fs.writeFileSync(ksaPath, syntheticKsa());
    const platform = {
        platform: 'Lares4Complete',
        ip: '192.0.2.10',
        pin: '000000',
        ...platformOverrides,
        ksaImport: { enabled: true, filePath: ksaPath, ...(platformOverrides.ksaImport ?? {}) },
    };
    fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify({ platforms: [platform] }, null, 4)}\n`);
    const runtime = JSON.parse(JSON.stringify(platform));
    const service = new KsaImportService(log, dir, new PlatformConfigFileService(log, dir));
    const persisted = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).platforms[0];
    return { runtime, service, persisted };
}

test('KSA exclusions: empty suggestions never erase the user lists (runtime and persisted)', async () => {
    const { runtime, service, persisted } = setup({
        excludeOutputs: ['5'],
        excludeZones: ['7'],
        excludeSensors: ['2'],
        excludeScenarios: ['9'],
        ksaImport: { applyAtStartup: true, applyExclusionSuggestions: true },
    });
    await service.prepare(runtime, 'Lares4Complete');

    for (const config of [runtime, persisted()]) {
        assert.deepEqual(config.excludeOutputs, ['5']);
        assert.deepEqual(config.excludeZones, ['7']);
        assert.deepEqual(config.excludeSensors, ['2']);
        assert.deepEqual(config.excludeScenarios, ['9']);
    }
    assert.equal(persisted().ksaImport.applyAtStartup, false);
});

test('KSA exclusions: suggestions are added to the user list, never replace it', () => {
    assert.equal(mergeExclusionList(['5'], []), undefined);
    assert.deepEqual(mergeExclusionList(['5', '6'], ['6', '7']), ['5', '6', '7']);
    assert.deepEqual(mergeExclusionList(undefined, ['7']), ['7']);
    assert.equal(mergeExclusionList(['5'], ['5']), undefined);
});
