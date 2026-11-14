'use strict';

// MAT-14: what the topology coordinator accepts as proof. An unregister is
// done only when the endpoint stays unreadable after the settle period, and a
// cluster without readable attributes is not an absent endpoint. A rename is
// done only when the endpoint shows the new label.

process.env.KLARES4_MATTER_UNREGISTER_TIMEOUT_MS = '300';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '20';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MatterTopologyCoordinator } = require('../dist/platform/matter-topology-coordinator.js');
const { makeHbMatterApi, deviceTypes } = require('./fixtures/hb-matter-api.js');

const log = { info() {}, warn() {}, debug() {}, error() {} };
const BRIDGED = 'bridgedDeviceBasicInformation';

test('MAT-14: an endpoint unreadable only for a moment is not taken as removed', async () => {
    let reads = 0;
    const api = { matter: {
        unregisterPlatformAccessories: async () => {},
        // The first read finds nothing (a transient error), every later one finds the endpoint.
        getAccessoryState: async () => (reads++ < 2 ? undefined : { nodeLabel: 'x' }),
    } };
    const coordinator = new MatterTopologyCoordinator(api, log);
    coordinator.remember({ UUID: 'zone_1', deviceType: { deviceType: 21 } });
    assert.equal(await coordinator.unregister('zone_1', 'booleanState'), false);
    assert.equal(coordinator.getState('zone_1'), 'failed');
});

test('MAT-14: a probe cluster without readable attributes does not count as an absent endpoint', async () => {
    const api = { matter: {
        unregisterPlatformAccessories: async () => {},
        getAccessoryState: async (_uuid, cluster) => (cluster === BRIDGED ? { nodeLabel: 'x' } : undefined),
    } };
    const coordinator = new MatterTopologyCoordinator(api, log);
    coordinator.remember({ UUID: 'zone_1', deviceType: { deviceType: 21 } });
    assert.equal(await coordinator.unregister('zone_1', 'booleanState'), false);
});

test('MAT-14: an unregister throwing with the registered accessory is reported as a warning', async () => {
    const warnings = [];
    const api = { matter: {
        unregisterPlatformAccessories: async () => { throw new Error('boom'); },
        getAccessoryState: async () => undefined,
    } };
    const coordinator = new MatterTopologyCoordinator(api, { ...log, warn: (m) => warnings.push(m) });
    coordinator.remember({ UUID: 'zone_1', deviceType: { deviceType: 21 } });
    assert.equal(await coordinator.unregister('zone_1', 'booleanState'), true);
    assert.equal(warnings.filter((w) => /threw/.test(w)).length, 1);
});

test('MAT-04: renameInPlace is a success only when the endpoint shows the new label', async () => {
    const hb = makeHbMatterApi();
    const accessory = {
        UUID: 'zone_1', displayName: 'Vecchio', deviceType: deviceTypes.ContactSensor,
        manufacturer: 'Ksenia', model: 'Lares4 zone', serialNumber: 'zone_1', clusters: { booleanState: { stateValue: true } },
    };
    await hb.api.matter.registerPlatformAccessories('p', 'P', [accessory]);
    const coordinator = new MatterTopologyCoordinator(hb.api, log);

    assert.equal(await coordinator.renameInPlace(accessory, 'Nuovo'), true);
    assert.equal(hb.endpoints.get('zone_1').nodeLabel, 'Nuovo');
    assert.deepEqual(hb.metadataUpdates, [{ UUID: 'zone_1', displayName: 'Nuovo' }]);
    assert.deepEqual(hb.unregisterCalls, []);

    // A runtime that drops the write: no success, and the cache record is left alone.
    hb.api.matter.updateAccessoryState = async () => undefined;
    assert.equal(await coordinator.renameInPlace(accessory, 'Altro'), false);
    assert.equal(hb.endpoints.get('zone_1').nodeLabel, 'Nuovo');
    assert.equal(hb.metadataUpdates.length, 1);
});
