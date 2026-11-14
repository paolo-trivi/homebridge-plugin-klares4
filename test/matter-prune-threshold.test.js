'use strict';

// The Matter prune never advances on a sync that saw less than half of the
// registered endpoints, however often it repeats (TD-T-06, mutation M08).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '5';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '10';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '5';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { makeHbMatterApi } = require('./fixtures/hb-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });

test('a sync that discovers less than half of the registered endpoints never advances the prune', { timeout: 20000 }, async (t) => {
    const hb = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    const light = (i) => ({ id: `light_${i}`, type: 'light', name: `Luce prova ${i}`, description: '', status: { on: false, dimmable: false } });
    registry.startDiscoveryCycle();
    for (let i = 0; i < 10; i++) await registry.addOrUpdateAccessory(light(i));
    await waitFor(() => [...Array(10).keys()].every((i) => registry.getStatus(`light_${i}`) === 'registered'));
    for (let cycle = 0; cycle < 5; cycle++) { // 4 of 10 answer: below the 50% floor
        registry.startDiscoveryCycle();
        for (let i = 0; i < 4; i++) await registry.addOrUpdateAccessory(light(i));
        await registry.pruneStaleAccessories();
    }
    assert.deepEqual(hb.unregisterCalls, [], 'a partial sync must not unregister anything, however often it repeats');
    for (let i = 0; i < 10; i++) assert.equal(registry.getStatus(`light_${i}`), 'registered');
});
