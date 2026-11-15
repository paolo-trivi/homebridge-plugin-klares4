'use strict';

// TH-14: the fallback store rewrites only files it understands, keeps a
// recovery in progress visible as `retrying`, and remembers which Thermostat
// payload a fallback was decided with (TH-01 automatic recovery).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MatterFallbackStore } = require('../dist/platform/matter-fallback-store.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const FILE = 'klares4-matter-fallback.json';
const record = (extra = {}) => ({ deviceId: 'thermostat_1', mode: 'fallback', reason: 'registration-failure', attempts: 0, pluginVersion: '2.2.0', ...extra });

function setup(t, content) {
    const dir = tmpStorage(t, 'klares4-fallback-int-');
    const file = path.join(dir, FILE);
    if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    const warnings = [];
    const log = { info() {}, debug() {}, error() {}, warn: (m) => warnings.push(String(m)) };
    return { dir, file, warnings, store: () => new MatterFallbackStore(dir, log), read: () => fs.readFileSync(file, 'utf8') };
}

for (const [label, content] of [
    ['a version written as a string', { version: '3', thermostats: [record()] }],
    ['version 2 with thermostats as an object', { version: 2, thermostats: { thermostat_1: record() } }],
    ['version 1 spelled out', { version: 1, thermostatAsTemperatureSensor: ['thermostat_1'] }],
    ['a newer numeric version', { version: 3, thermostats: [record()] }],
]) {
    test(`TH-14: ${label} is left untouched`, (t) => {
        const s = setup(t, content);
        const before = s.read();
        const store = s.store();
        assert.deepEqual([...store.load()], []);
        store.add('thermostat_9');
        assert.equal(store.has('thermostat_9'), true, 'state is kept in memory');
        assert.equal(s.read(), before);
        assert.deepEqual(fs.readdirSync(s.dir), [FILE]);
        assert.equal(s.warnings.length, 1);
    });
}

test('TH-14: an unreadable file is copied aside before the store starts again', (t) => {
    const s = setup(t, '{"version":2,"thermostats":[{"deviceId":"thermo');
    const store = s.store();
    assert.deepEqual([...store.load()], []);
    store.add('thermostat_9');
    assert.equal(fs.readFileSync(`${s.file}.unreadable.bak`, 'utf8'), '{"version":2,"thermostats":[{"deviceId":"thermo');
    assert.deepEqual(JSON.parse(s.read()).thermostats.map((r) => r.deviceId), ['thermostat_9']);
    assert.ok(s.warnings[0].includes('unreadable'));
});

test('TH-14: a recovery in progress stays "retrying" for the rest of the process', (t) => {
    const s = setup(t, { version: 2, thermostats: [record()] });
    const store = s.store();
    assert.equal(store.beginRecovery('thermostat_1', 1), true);
    assert.equal(store.getRecord('thermostat_1').mode, 'retrying');
    store.load();
    store.has('thermostat_1');
    assert.equal(store.getRecord('thermostat_1').mode, 'retrying');
    assert.equal(JSON.parse(s.read()).thermostats[0].mode, 'retrying');
    store.markNative('thermostat_1');
    assert.equal(store.getRecord('thermostat_1').reason, 'recovered');
});

test('TH-14: a recovery left "retrying" by a previous process is interrupted once, at the first read', (t) => {
    const s = setup(t, { version: 2, thermostats: [record({ mode: 'retrying', attempts: 1, lastProcessedRecoveryRequest: 1, nativeShapeRevision: 2 })] });
    const store = s.store();
    assert.deepEqual([...store.load()], ['thermostat_1']);
    assert.equal(store.getRecord('thermostat_1').reason, 'interrupted-recovery');
    assert.equal(store.beginRecovery('thermostat_1', 1), false, 'the generation was consumed');
    assert.equal(store.needsAutomaticRecovery('thermostat_1'), false);
});

test('TH-14: malformed optional fields are dropped, not trusted', (t) => {
    const s = setup(t, { version: 2, thermostats: [record({ lastProcessedRecoveryRequest: 'x', nativeShapeRevision: '2' })] });
    const store = s.store();
    assert.equal(store.getRecord('thermostat_1').lastProcessedRecoveryRequest, undefined);
    assert.equal(store.needsAutomaticRecovery('thermostat_1'), true);
});

test('TH-01: a fallback from an older payload gets exactly one automatic attempt', (t) => {
    const s = setup(t, { thermostatAsTemperatureSensor: ['thermostat_1'] });
    const store = s.store();
    assert.equal(store.needsAutomaticRecovery('thermostat_1'), true);
    assert.equal(store.beginAutomaticRecovery('thermostat_1'), true);
    store.add('thermostat_1', 'registration-failure');
    assert.equal(store.beginAutomaticRecovery('thermostat_1'), false);
    assert.equal(s.store().needsAutomaticRecovery('thermostat_1'), false, 'also after a restart');
    assert.equal(s.store().beginRecovery('thermostat_1', 1), true, 'an explicit request still works');
});

test('TH-01: a fallback decided by this version is not retried automatically', (t) => {
    const s = setup(t);
    const store = s.store();
    store.add('thermostat_2');
    assert.equal(store.needsAutomaticRecovery('thermostat_2'), false);
    assert.equal(JSON.parse(s.read()).thermostats[0].nativeShapeRevision, 2);
});
