'use strict';

// Which replacements of an endpoint keep the controllers' identity (uniqueId),
// on the real Homebridge Matter stack: the stale-endpoint purge and the second
// Thermostat payload are the same device and keep it; the TemperatureSensor
// fallback is another kind of device and gets a new one. Also: the dimmer
// upgrade is logged as such, the probe ignores the bridged information that
// Homebridge adds to the plugin's clusters, and the unregister settle is a
// registry timing.

process.env.KLARES4_MATTER_UNREGISTER_TIMEOUT_MS = '3000';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { isMatterAccessoryQueryable } = require('../dist/platform/matter-registration-recovery.js');
const { resolveMatterTimings } = require('../dist/platform/matter-registry-types.js');
const { SyncLifecycle } = require('../dist/platform/sync-lifecycle.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');
const { makeHbMatterApi } = require('./fixtures/hb-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const BRIDGED = 'bridgedDeviceBasicInformation';
const TIMINGS = {
    registerProbeTimeoutMs: 1500, settledRegisterProbeTimeoutMs: 1500, registerProbePollMs: 10,
    registerProbePollMaxMs: 30, stateBootstrapMs: 0, unregisterSettleMs: 0,
};
// The fixture on both Homebridge semantics: a settle (150 ms) longer than the close (80 ms).
const FIXTURE_TIMINGS = { ...TIMINGS, unregisterSettleMs: 150 };
const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });
function recordingLog() {
    const lines = [];
    const push = (m) => lines.push(String(m));
    return { lines, info: push, warn: push, error: push, debug() {}, success: push };
}

const light = (n, status) => ({ id: `light_${n}`, type: 'light', name: `Lampada ${n}`, description: '', status });
const thermostat = (n) => {
    const status = { currentTemperature: 20, targetTemperature: 21, mode: 'heat' };
    return { id: `thermostat_${n}`, type: 'thermostat', name: `Termostato ${n}`, description: '', ...status, status };
};

/** Makes `cluster` of `uuid` unreadable for the endpoints built while `blocked()` holds. */
function hideCluster(t, stack, uuid, cluster, blocked) {
    const read = stack.api.matter.getAccessoryState.bind(stack.api.matter);
    t.mock.method(stack.api.matter, 'getAccessoryState', (id, name, partId) => (
        id === uuid && name === cluster && blocked() ? Promise.resolve(undefined) : read(id, name, partId)
    ));
}

function registryOn(stack, t, log = silentLog()) {
    const registry = new MatterAccessoryRegistry({
        api: stack.api, log, getWsClient: () => undefined, storagePath: tmpStorage(t, 'klares4-identity-'), timings: TIMINGS,
    });
    registry.startDiscoveryCycle();
    return registry;
}

test('stale-endpoint purge: the re-registered endpoint keeps the uniqueId', { timeout: 120000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    let endpoints = 0;
    const register = stack.api.matter.registerPlatformAccessories.bind(stack.api.matter);
    t.mock.method(stack.api.matter, 'registerPlatformAccessories', async (...args) => { endpoints += 1; return register(...args); });
    hideCluster(t, stack, 'light_1', 'onOff', () => endpoints < 2);
    const registry = registryOn(stack, t);

    await registry.addOrUpdateAccessory(light(1, { on: false, dimmable: false }));
    await stack.until(() => stack.record('light_1'), 'first light_1 endpoint');
    const first = stack.read('light_1', BRIDGED).uniqueId;
    await waitFor(() => registry.getStatus('light_1') === 'registered', 10000);

    assert.equal(endpoints, 2, 'one purge and re-register');
    assert.equal(stack.read('light_1', BRIDGED).uniqueId, first);
});

// On Homebridge 2.5 the 2.2.0 payload is refused (MAT-01), so the second
// attempt cannot be shown on the real stack; the fixture accepts both payloads.
// One UUID per run: the Thermostat payload choice is remembered per UUID for
// the whole process (matter-thermostat-shape.ts), as it is in production.
for (const [semantics, uuid] of [['2.4', 'thermostat_2'], ['2.5', 'thermostat_12']]) test(`second Thermostat payload: same device, same uniqueId (${semantics})`, async (t) => {
    const hb = makeHbMatterApi({ semantics, unregisterCloseMs: 80, unqueryableOnce: [uuid] });
    // The identity the endpoint has at the very moment the plugin declares it registered.
    const atRegistered = [];
    const log = { ...silentLog(), debug: (m) => {
        if (String(m).startsWith('[Matter] registered:')) atRegistered.push(hb.endpoints.get(uuid)?.uniqueId);
    } };
    const registry = new MatterAccessoryRegistry({
        api: hb.api, log, getWsClient: () => undefined, storagePath: tmpStorage(t, 'klares4-identity-'), timings: FIXTURE_TIMINGS,
    });
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(thermostat(Number(uuid.split('_')[1])));
    // On 2.4 the register returns before the endpoint is built.
    await waitFor(() => hb.endpoints.has(uuid));
    const first = hb.endpoints.get(uuid).uniqueId;
    await waitFor(() => registry.getStatus(uuid) === 'registered', 10000);

    assert.equal(hb.registerCalls.length, 2, 'conformant payload, then the 2.2.0 one');
    assert.equal(hb.endpoints.get(uuid).deviceType.name, 'Thermostat');
    assert.deepEqual(atRegistered, [first], 'the identity is in place before the endpoint counts as registered');
    assert.equal(hb.endpoints.get(uuid).uniqueId, first);
});

// Real stack: the conformant Thermostat endpoint does not answer, the 2.2.0
// payload is refused by matter.js, the TemperatureSensor comes up.
test('TemperatureSensor fallback: another kind of device, new uniqueId', { timeout: 120000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    hideCluster(t, stack, 'thermostat_3', 'thermostat', () => true);
    const registry = registryOn(stack, t);

    await registry.addOrUpdateAccessory(thermostat(3));
    await stack.until(() => stack.record('thermostat_3'), 'first thermostat_3 endpoint');
    const first = stack.read('thermostat_3', BRIDGED).uniqueId;
    await waitFor(() => stack.deviceTypeName('thermostat_3') === 'TemperatureSensor'
        && registry.getStatus('thermostat_3') === 'registered', 10000);

    assert.notEqual(stack.read('thermostat_3', BRIDGED).uniqueId, first);
});

for (const semantics of ['2.4', '2.5']) test(`the dimmer upgrade is logged as an upgrade and keeps the uniqueId (${semantics})`, async (t) => {
    const hb = makeHbMatterApi({ semantics, unregisterCloseMs: 80 });
    const log = recordingLog();
    const registry = new MatterAccessoryRegistry({
        api: hb.api, log, getWsClient: () => undefined, storagePath: tmpStorage(t, 'klares4-identity-'), timings: FIXTURE_TIMINGS,
    });
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(light(4, { on: true, dimmable: false }));
    await waitFor(() => registry.getStatus('light_4') === 'registered');
    const uniqueId = hb.endpoints.get('light_4').uniqueId;

    await registry.updateAccessoryState(light(4, { on: true, dimmable: true, brightness: 50 }));
    assert.deepEqual(hb.log, [], 'no register raced the close');
    await waitFor(() => hb.endpoints.get('light_4')?.deviceType.name === 'DimmableLight' && registry.getStatus('light_4') === 'registered');

    const requested = log.lines.filter((l) => l.includes('register requested'));
    assert.match(requested.at(-1), /\[upgrade\]/);
    assert.equal(requested.some((l) => l.includes('[rename]')), false);
    assert.equal(hb.endpoints.get('light_4').uniqueId, uniqueId);
});

test('the probe checks the declared clusters, not the bridged information Homebridge adds to them', async () => {
    const reads = [];
    const api = { matter: { getAccessoryState: async (_uuid, cluster) => { reads.push(cluster); return cluster === 'onOff' ? {} : undefined; } } };
    // Homebridge writes bridged information updates into the plugin's own clusters object.
    const reg = { uuid: 'light_5', displayName: 'L', matterAccessory: { clusters: { onOff: {}, [BRIDGED]: { reachable: true } } } };
    assert.equal(await isMatterAccessoryQueryable(api, silentLog(), String, reg), true);
    assert.deepEqual(reads, ['onOff']);
});

test('the unregister settle is a registry timing (env as default, option wins)', () => {
    assert.equal(resolveMatterTimings({}, {}).unregisterSettleMs, 1000);
    assert.equal(resolveMatterTimings({}, { KLARES4_MATTER_UNREGISTER_SETTLE_MS: '0' }).unregisterSettleMs, 0);
    assert.equal(resolveMatterTimings({ unregisterSettleMs: 5 }, { KLARES4_MATTER_UNREGISTER_SETTLE_MS: '0' }).unregisterSettleMs, 5);
});

// T0.2/F1: two finalize passes in a row used to end in "already registered".
// With the rename in place nothing is unregistered; on both semantics.
for (const semantics of ['2.4', '2.5']) test(`two finalize passes in a row: renamed in place, no "already registered" (${semantics})`, async (t) => {
    const hb = makeHbMatterApi({ semantics, unregisterCloseMs: 80 });
    const registry = new MatterAccessoryRegistry({
        api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t, 'klares4-identity-'), timings: FIXTURE_TIMINGS,
    });
    const zone = (n, name) => ({ id: `zone_${n}`, type: 'zone', name, description: '', status: { armed: false, bypassed: false, fault: false, open: false } });
    const cover = (n, name) => ({ id: `cover_${n}`, type: 'cover', name, description: '', status: { position: 0, state: 'stopped' } });
    const devices = [1, 2, 3].map((n) => zone(n, `Finestra ${n}`));
    const lifecycle = new SyncLifecycle({
        log: silentLog(),
        accessoryRegistry: { startDiscoveryCycle() {}, pruneStaleAccessories() {} },
        matterRegistry: registry,
        eligibleMatterDevices: () => devices,
    });
    lifecycle.startSync();
    for (const device of devices) await registry.addOrUpdateAccessory(device);
    for (const n of [1, 2, 3]) devices.push(cover(10 + n, `Finestra ${n}`));
    for (const device of devices.slice(3)) await registry.addOrUpdateAccessory(device);
    await waitFor(() => devices.every((d) => registry.getStatus(d.id) === 'registered'));

    await registry.finalizeNameMap(devices);
    await registry.finalizeNameMap(devices);
    await waitFor(() => devices.every((d) => registry.getStatus(d.id) === 'registered'));
    await hb.settle();

    assert.deepEqual(hb.log.filter((l) => /already registered/.test(l)), []);
    for (const n of [1, 2, 3]) assert.equal(hb.endpoints.get(`zone_${n}`).nodeLabel, `Finestra ${n} - Sens.`);
});

// RC1-07: a purge of an endpoint whose identity cannot be read says so.
test('a same-device replacement without a readable uniqueId logs a warning', async () => {
    const { replaceEndpoint } = require('../dist/platform/matter-endpoint-replacement.js');
    const { MatterTopologyCoordinator } = require('../dist/platform/matter-topology-coordinator.js');
    const warnings = [];
    const api = { matter: {
        unregisterPlatformAccessories: async () => {},
        // The broken endpoint answers no read, the bridged information included.
        getAccessoryState: async () => undefined,
    } };
    const coordinator = new MatterTopologyCoordinator(api, { ...silentLog(), warn: (m) => warnings.push(m) }, 200, 0);
    const reg = { uuid: 'light_6', matterAccessory: { UUID: 'light_6', clusters: { onOff: {} } } };
    await replaceEndpoint(reg, coordinator, 'same-device');
    assert.equal(reg.inheritedUniqueId, undefined);
    assert.equal(warnings.filter((w) => /shows no uniqueId/.test(w)).length, 1);

    warnings.length = 0;
    await replaceEndpoint({ ...reg }, coordinator, 'other-device');
    assert.deepEqual(warnings.filter((w) => /uniqueId/.test(w)), [], 'another kind of device: nothing to keep, nothing to report');
});
