'use strict';

// MAT-04 / MAT-14: a Matter rename is a nodeLabel update on the live endpoint,
// observed by reading the label back; the endpoint (and its uniqueId) is
// replaced only when the label did not change. Checked on the real Homebridge
// Matter stack, which is the only place uniqueId and nodeLabel persistence
// exist.

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '2000';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '10';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '50';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '10';
process.env.KLARES4_MATTER_UNREGISTER_TIMEOUT_MS = '3000';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');
const { makeHbMatterApi } = require('./fixtures/hb-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const BRIDGED = 'bridgedDeviceBasicInformation';
const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });

const zone = (n, name) => ({ id: `zone_${n}`, type: 'zone', name, description: '', status: { armed: false, bypassed: false, fault: false, open: false } });
const cover = (n, name) => ({ id: `cover_${n}`, type: 'cover', name, description: '', status: { position: 30, state: 'stopped' } });
const light = (n, status) => ({ id: `light_${n}`, type: 'light', name: `Lampada ${n}`, description: '', status });

function registryOn(stack, storagePath) {
    const registry = new MatterAccessoryRegistry({ api: stack.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    registry.startDiscoveryCycle();
    return registry;
}

async function registerAll(registry, devices) {
    for (const device of devices) await registry.addOrUpdateAccessory(device);
    await waitFor(() => devices.every((d) => registry.getStatus(d.id) === 'registered'), 10000);
}

const hbUnregistered = (stack) => stack.hbLines.filter((l) => /Unregistered Matter accessory|already registered/.test(l));

test('MAT-04: a collision rename keeps the endpoint and its uniqueId, and survives a restart', { timeout: 120000 }, async (t) => {
    const session = realMatterStackSession(t);
    const storagePath = tmpStorage(t, 'klares4-rename-');
    // Zones first: the zone takes the clean name, the batch map gives it to the cover.
    const devices = [zone(1, 'Vetrata Nord'), cover(2, 'Vetrata Nord')];

    const boot1 = await session.start();
    const registry1 = registryOn(boot1, storagePath);
    await registerAll(registry1, devices);
    const before = boot1.read('zone_1', BRIDGED);
    assert.equal(before.nodeLabel, 'Vetrata Nord');
    const unregisterSpy = t.mock.method(boot1.api.matter, 'unregisterPlatformAccessories');

    await registry1.finalizeNameMap(devices);

    const after = boot1.read('zone_1', BRIDGED);
    assert.equal(after.nodeLabel, 'Vetrata Nord - Sens.');
    assert.equal(after.uniqueId, before.uniqueId, 'uniqueId must not change on rename');
    assert.equal(unregisterSpy.mock.callCount(), 0);
    assert.deepEqual(hbUnregistered(boot1), []);
    assert.equal(registry1.getStatus('zone_1'), 'registered');
    await boot1.stop();

    const boot2 = await session.start();
    assert.equal(boot2.read('zone_1', BRIDGED).nodeLabel, 'Vetrata Nord - Sens.');
    assert.equal(boot2.read('zone_1', BRIDGED).uniqueId, before.uniqueId);
    const registry2 = registryOn(boot2, storagePath);
    for (const accessory of boot2.cached()) registry2.configureCachedAccessory(accessory);
    await registerAll(registry2, devices);
    const updateSpy = t.mock.method(boot2.api.matter, 'updateAccessoryState');
    await registry2.finalizeNameMap(devices);
    // Only label writes: reachability also writes this cluster, on its own timers.
    const labelWrites = updateSpy.mock.calls.filter((c) => c.arguments[1] === BRIDGED && 'nodeLabel' in c.arguments[2]);
    assert.equal(labelWrites.length, 0, 'no rename on a steady boot');
    assert.equal(boot2.read('zone_1', BRIDGED).nodeLabel, 'Vetrata Nord - Sens.');
});

test('MAT-04: when the endpoint does not take the label, the fallback replaces it and keeps the uniqueId', { timeout: 120000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const storagePath = tmpStorage(t, 'klares4-rename-');
    const devices = [zone(3, 'Porta Sud'), cover(4, 'Porta Sud')];
    const registry = registryOn(stack, storagePath);
    await registerAll(registry, devices);
    const uniqueId = stack.read('zone_3', BRIDGED).uniqueId;

    // A runtime that ignores nodeLabel writes: the rename is not observed in place.
    const update = stack.api.matter.updateAccessoryState.bind(stack.api.matter);
    t.mock.method(stack.api.matter, 'updateAccessoryState', (uuid, cluster, attributes, partId) => (
        cluster === BRIDGED && 'nodeLabel' in attributes ? Promise.resolve() : update(uuid, cluster, attributes, partId)
    ));

    await registry.finalizeNameMap(devices);
    await waitFor(() => registry.getStatus('zone_3') === 'registered', 10000);

    const after = stack.read('zone_3', BRIDGED);
    assert.equal(after.nodeLabel, 'Porta Sud - Sens.');
    assert.equal(after.uniqueId, uniqueId, 'the replacement endpoint gets the previous uniqueId back');
    assert.deepEqual(stack.hbLines.filter((l) => /already registered/.test(l)), []);
});

test('MAT-04: the dimmer upgrade (a device type change) keeps the uniqueId', { timeout: 120000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const storagePath = tmpStorage(t, 'klares4-rename-');
    const registry = registryOn(stack, storagePath);
    await registerAll(registry, [light(5, { on: true, dimmable: false })]);
    assert.equal(stack.deviceTypeName('light_5'), 'OnOffLight');
    const uniqueId = stack.read('light_5', BRIDGED).uniqueId;

    await registry.updateAccessoryState(light(5, { on: true, dimmable: true, brightness: 60 }));
    await waitFor(() => stack.deviceTypeName('light_5') === 'DimmableLight' && registry.getStatus('light_5') === 'registered', 10000);

    assert.equal(stack.read('light_5', BRIDGED).uniqueId, uniqueId);
});

// T0.2 / RC1-01: with Homebridge 2.4's semantics (unregister resolves while
// the endpoint is still closing, register returns before the endpoint exists)
// two finalize passes in a row used to end in "already registered". The
// fallback path must be correct on both; the settle (150 ms) is longer than
// the close (80 ms), as the 1 s default is longer than a real close.
for (const [semantics, unregisterCloseMs] of [['2.4', 0], ['2.4', 80], ['2.5', 0], ['2.5', 80]]) {
    test(`MAT-04: the rename fallback is correct on ${semantics}, close ${unregisterCloseMs} ms, also run twice`, async (t) => {
        const hb = makeHbMatterApi({ semantics, unregisterCloseMs });
        // The fixture models a runtime where the label write is ignored.
        const update = hb.api.matter.updateAccessoryState;
        hb.api.matter.updateAccessoryState = async (uuid, cluster, attributes) => (
            cluster === BRIDGED && 'nodeLabel' in attributes ? undefined : update(uuid, cluster, attributes)
        );
        const registry = new MatterAccessoryRegistry({
            api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t, 'klares4-rename-'),
            timings: { unregisterSettleMs: 150 },
        });
        registry.startDiscoveryCycle();
        const devices = [zone(6, 'Ingresso'), cover(7, 'Ingresso')];
        await registerAll(registry, devices);

        await registry.finalizeNameMap(devices);
        await registry.finalizeNameMap(devices);
        await waitFor(() => devices.every((d) => registry.getStatus(d.id) === 'registered'));
        await hb.settle();

        assert.deepEqual(hb.log.filter((l) => /already registered/.test(l)), []);
        assert.deepEqual(hb.unregisterCalls, ['zone_6']);
        assert.equal(hb.endpoints.get('zone_6').nodeLabel, 'Ingresso - Sens.');
    });
}
