const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { KsaCacheService } = require('../dist/ksa/cache-service.js');
const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');

function makeLog() {
    const warnings = [];
    return { warnings, log: { info() {}, warn: (m) => warnings.push(m), error() {}, debug() {} } };
}

function validCache() {
    return {
        sourceFileHash: 'abc',
        parsedAt: '2026-01-01T00:00:00.000Z',
        thermostatPrograms: [{ id: '3', description: 'Termostato Test', heatingOutputId: '21', domusSensorId: '4' }],
        thermostatProgramIdByOutputId: { 21: '3' },
        domusSensorIdByThermostatProgramId: { 3: '4' },
        outputNamesById: { 21: 'Riscaldamento Test' },
        zoneNamesById: {},
        scenarioNamesById: {},
        domusSensorNamesById: {},
        roomNameById: {},
        roomDeviceRefs: [],
    };
}

function storageWith(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-ksa-cache-'));
    if (content !== undefined) {
        fs.writeFileSync(path.join(dir, 'klares4-ksa-cache.json'), typeof content === 'string' ? content : JSON.stringify(content));
    }
    return dir;
}

test('F19: a valid cache is loaded', async () => {
    const { log } = makeLog();
    const loaded = await new KsaCacheService(storageWith(validCache()), log).load();
    assert.deepEqual(loaded, validCache());
});

test('F19: a parsable but incomplete cache is discarded with a warning', async () => {
    const { log, warnings } = makeLog();
    const loaded = await new KsaCacheService(storageWith({ thermostatPrograms: [] }), log).load();
    assert.equal(loaded, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /KSA cache/);
});

test('F19: maps of the wrong shape are rejected', async () => {
    const variants = [
        { thermostatProgramIdByOutputId: [] },
        { domusSensorIdByThermostatProgramId: null },
        { outputNamesById: { 1: 42 } },
        { roomDeviceRefs: {} },
        { thermostatPrograms: [null] },
        { thermostatPrograms: [{ description: 'no id' }] },
    ];
    for (const patch of variants) {
        const { log } = makeLog();
        const loaded = await new KsaCacheService(storageWith({ ...validCache(), ...patch }), log).load();
        assert.equal(loaded, undefined, JSON.stringify(patch));
    }
    const { log } = makeLog();
    assert.equal(await new KsaCacheService(storageWith('null'), log).load(), undefined);
});

test('F19: a missing cache file stays silent', async () => {
    const { log, warnings } = makeLog();
    assert.equal(await new KsaCacheService(storageWith(undefined), log).load(), undefined);
    assert.deepEqual(warnings, []);
});

test('F19: the websocket client state tolerates a cache without maps', () => {
    const state = createInitialWebSocketClientState(undefined, { thermostatPrograms: [null, { id: '3' }] });
    assert.equal(state.thermostatProgramIdByOutputId.size, 0);
    assert.equal(state.thermostatProgramById.get('3').ID, '3');
});

test('F19/F32: the cache is saved atomically', async () => {
    const dir = storageWith(undefined);
    const { log } = makeLog();
    const renames = [];
    const originalRename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
        renames.push([from, to]);
        return originalRename(from, to);
    };
    try {
        await new KsaCacheService(dir, log).save(validCache());
    } finally {
        fs.promises.rename = originalRename;
    }
    const target = path.join(dir, 'klares4-ksa-cache.json');
    assert.equal(renames.length, 1);
    assert.equal(renames[0][1], target);
    assert.deepEqual(fs.readdirSync(dir), ['klares4-ksa-cache.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), validCache());
});
