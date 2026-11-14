const test = require('node:test');
const assert = require('node:assert/strict');

const { deviceToMatterAccessory } = require('../dist/platform/matter-device-mapper.js');
const { buildStateUpdates } = require('../dist/platform/matter-state-updates.js');
const { deviceTypes } = require('./fixtures/hb24-matter-api.js');

const silentLog = () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} });
const deps = () => ({ api: { matter: { deviceTypes } }, log: silentLog(), getWsClient: () => undefined });

function cover(status) {
    return { id: 'cover_7', type: 'cover', name: 'Tapparella Sala', description: '', status };
}

// Lares4 0 = closed / 100 = open; Matter percent100ths 0 = open / 10000 = closed.
test('WindowCovering state update exposes the panel target, not the current position', () => {
    const [update] = buildStateUpdates(cover({ position: 20, targetPosition: 80, state: 'opening' }));
    assert.equal(update.clusterName, 'windowCovering');
    assert.equal(update.attributes.currentPositionLiftPercent100ths, 8000);
    assert.equal(update.attributes.targetPositionLiftPercent100ths, 2000);
});

test('WindowCovering state update falls back to the current position when the panel sends no target', () => {
    const [update] = buildStateUpdates(cover({ position: 30, state: 'stopped' }));
    assert.equal(update.attributes.currentPositionLiftPercent100ths, 7000);
    assert.equal(update.attributes.targetPositionLiftPercent100ths, 7000);
});

test('WindowCovering registration carries the panel target as initial target', () => {
    const accessory = deviceToMatterAccessory(cover({ position: 100, targetPosition: 0, state: 'closing' }), deps());
    assert.equal(accessory.clusters.windowCovering.currentPositionLiftPercent100ths, 0);
    assert.equal(accessory.clusters.windowCovering.targetPositionLiftPercent100ths, 10000);
});
