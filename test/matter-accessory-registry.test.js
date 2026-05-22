const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '1000';
// Speed up probe-based settle in tests
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '10';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '20';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');

function tmpStorage() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-test-'));
}

// Mirrors api.matter.deviceTypes — we don't need the real Matter device types, just placeholder
// objects (the registry forwards them blindly to the mock register).
const fakeDeviceTypes = {
    OnOffLight: { _t: 'OnOffLight' },
    DimmableLight: { _t: 'DimmableLight' },
    WindowCovering: { _t: 'WindowCovering' },
    Thermostat: { _t: 'Thermostat' },
    TemperatureSensor: { _t: 'TemperatureSensor' },
    HumiditySensor: { _t: 'HumiditySensor' },
    LightSensor: { _t: 'LightSensor' },
    MotionSensor: { _t: 'MotionSensor' },
    ContactSensor: { _t: 'ContactSensor' },
    OnOffSwitch: { _t: 'OnOffSwitch' },
    OnOffOutlet: { _t: 'OnOffOutlet' },
};

function silentLog() {
    return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

function makeApi({ registerImpl, updateImpl, unregisterImpl } = {}) {
    const registered = [];
    const queryable = new Set();
    const updates = [];
    const metadataUpdates = [];
    const unregistered = [];

    const matter = {
        deviceTypes: fakeDeviceTypes,
        registerPlatformAccessories: async (_p, _pl, accessories) => {
            for (const a of accessories) {
                if (registerImpl) {
                    const res = registerImpl(a);
                    if (res === 'throw') throw new Error('synthetic registration failure');
                    if (res !== 'missing-state') queryable.add(a.UUID);
                } else {
                    queryable.add(a.UUID);
                }
                registered.push({
                    UUID: a.UUID,
                    displayName: a.displayName,
                    manufacturer: a.manufacturer,
                    model: a.model,
                    serialNumber: a.serialNumber,
                    firmwareRevision: a.firmwareRevision,
                    deviceType: a.deviceType,
                });
            }
        },
        updatePlatformAccessories: async (accessories) => {
            for (const a of accessories) {
                metadataUpdates.push({
                    UUID: a.UUID,
                    displayName: a.displayName,
                    manufacturer: a.manufacturer,
                    model: a.model,
                    serialNumber: a.serialNumber,
                    firmwareRevision: a.firmwareRevision,
                    deviceType: a.deviceType,
                });
            }
        },
        updateAccessoryState: async (uuid, clusterName, attributes, partId) => {
            if (updateImpl) updateImpl(uuid, clusterName, attributes, partId);
            updates.push({ uuid, clusterName, attributes, partId });
        },
        getAccessoryState: async (uuid) => {
            return queryable.has(uuid) ? {} : undefined;
        },
        unregisterPlatformAccessories: async (_p, _pl, accessories) => {
            if (unregisterImpl) unregisterImpl(accessories);
            for (const a of accessories) {
                queryable.delete(a.UUID);
                unregistered.push(a.UUID);
            }
        },
    };

    const api = { matter };
    return { api, registered, updates, metadataUpdates, unregistered };
}

function lightDevice(id = 'light_1', extras = {}) {
    return {
        id,
        type: 'light',
        name: `Light ${id}`,
        description: '',
        status: { on: true, dimmable: false, ...extras },
    };
}

function thermostatDevice(id = 'thermostat_18', extras = {}) {
    return {
        id,
        type: 'thermostat',
        name: 'Riscaldamento Sala',
        description: '',
        currentTemperature: 21,
        targetTemperature: 20,
        mode: 'heat',
        status: {},
        ...extras,
    };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Probe-based settle is fast in tests (queryable on first probe, ~10ms).
// Bootstrap default is 0; the state-update env override (1000) still applies.
const SETTLE_AND_UPDATE_FLUSH_MS = 1200;
const FALLBACK_SETTLE_AND_UPDATE_FLUSH_MS = 2400;

// ---------------------------------------------------------------------------

test('does not crash when api.matter is undefined', async () => {
    const api = { matter: undefined };
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    assert.equal(registry.isEnabled, false);
    await registry.addOrUpdateAccessory(lightDevice());
    await registry.updateAccessoryState(lightDevice());
    await registry.pruneStaleAccessories();
    // Nothing should throw, and no state should be tracked.
    assert.equal(registry.getStatus('light_1'), undefined);
});

test('addOrUpdateAccessory: register → pending → settled → registered', async () => {
    const { api, registered, metadataUpdates } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    await registry.addOrUpdateAccessory(lightDevice());
    assert.equal(registered.length, 1);
    assert.equal(registry.getStatus('light_1'), 'pending');
    await delay(200); // > MATTER_REGISTER_SETTLE_MS
    assert.equal(registry.getStatus('light_1'), 'registered');
    assert.equal(metadataUpdates.length, 0, 'must not call updatePlatformAccessories because it drops endpoints in HB2');
    assert.equal(registered[0].manufacturer, 'Ksenia');
    assert.equal(registered[0].model, 'Lares4 light');
    assert.equal(registered[0].serialNumber, 'light_1');
    assert.match(registered[0].firmwareRevision, /^\d+\.\d+\.\d+$/);
});

test('status updates received during the settle window are queued, not pushed', async () => {
    const { api, updates } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    await registry.addOrUpdateAccessory(lightDevice('light_2'));
    assert.equal(registry.getStatus('light_2'), 'pending');
    assert.equal(updates.length, 0);
    await registry.updateAccessoryState({ ...lightDevice('light_2'), status: { on: false, dimmable: false } });
    assert.equal(updates.length, 0, 'updateAccessoryState must not be called during settle');
    assert.equal(registry.getPendingCount('light_2'), 1, 'state should be queued');
});

test('queued updates are flushed after the settle window', async () => {
    const { api, updates } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    await registry.addOrUpdateAccessory(lightDevice('light_3'));
    await registry.updateAccessoryState({ ...lightDevice('light_3'), status: { on: false, dimmable: false } });
    assert.equal(updates.length, 0);
    await delay(SETTLE_AND_UPDATE_FLUSH_MS);
    assert.ok(updates.length >= 1, 'queued update should be flushed after settle');
    assert.equal(updates[0].uuid, 'light_3');
    assert.equal(updates[0].clusterName, 'onOff');
    assert.deepEqual(updates[0].attributes, { onOff: false });
});

test('queue dedupes by (clusterName, partId): only latest payload is kept', async () => {
    const { api, updates } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    await registry.addOrUpdateAccessory(lightDevice('light_4'));
    // Three updates for the same cluster — only the last one should remain queued
    await registry.updateAccessoryState({ ...lightDevice('light_4'), status: { on: false, dimmable: false } });
    await registry.updateAccessoryState({ ...lightDevice('light_4'), status: { on: true, dimmable: false } });
    await registry.updateAccessoryState({ ...lightDevice('light_4'), status: { on: false, dimmable: false } });
    assert.equal(registry.getPendingCount('light_4'), 1);
    await delay(SETTLE_AND_UPDATE_FLUSH_MS);
    const onOffUpdates = updates.filter((u) => u.uuid === 'light_4' && u.clusterName === 'onOff');
    assert.equal(onOffUpdates.length, 1);
    assert.deepEqual(onOffUpdates[0].attributes, { onOff: false });
});

test('post-settle: updates are pushed immediately', async () => {
    const { api, updates } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    await registry.addOrUpdateAccessory(lightDevice('light_5'));
    await delay(SETTLE_AND_UPDATE_FLUSH_MS); // settle + state update bootstrap
    updates.length = 0;
    await registry.updateAccessoryState({ ...lightDevice('light_5'), status: { on: false, dimmable: false } });
    await delay(20); // post-bootstrap flush still goes through the queue's setTimeout(0)
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].attributes, { onOff: false });
});

test('thermostat: registers as Thermostat when matter accepts it', async () => {
    const { api, registered } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    await registry.addOrUpdateAccessory(thermostatDevice('thermostat_50'));
    await delay(200);
    assert.equal(registry.getStatus('thermostat_50'), 'registered');
    assert.equal(registered[0].deviceType._t, 'Thermostat');
});

test('thermostat: falls back to TemperatureSensor when matter rejects the Thermostat', async () => {
    let rejectedOnce = false;
    const { api, registered } = makeApi({
        registerImpl: (acc) => {
            if (!rejectedOnce && acc.deviceType._t === 'Thermostat') {
                rejectedOnce = true;
                return 'throw';
            }
            return undefined;
        },
    });
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    await registry.addOrUpdateAccessory(thermostatDevice('thermostat_60'));
    // After failure, fallback should have been registered
    assert.equal(registered.length, 1, 'first attempt failed, fallback was retried with TemperatureSensor');
    assert.equal(registered[0].deviceType._t, 'TemperatureSensor');
    await delay(200);
    assert.equal(registry.getStatus('thermostat_60'), 'registered');
});

test('thermostat: async missing registration falls back before state updates', async () => {
    let missingOnce = false;
    const { api, registered, updates } = makeApi({
        registerImpl: (acc) => {
            if (!missingOnce && acc.deviceType._t === 'Thermostat') {
                missingOnce = true;
                return 'missing-state';
            }
            return undefined;
        },
    });
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    await registry.addOrUpdateAccessory(thermostatDevice('thermostat_async_missing'));
    await registry.updateAccessoryState(thermostatDevice('thermostat_async_missing', { currentTemperature: 19.5 }));
    await delay(FALLBACK_SETTLE_AND_UPDATE_FLUSH_MS);

    assert.equal(registry.getStatus('thermostat_async_missing'), 'registered');
    assert.equal(registered[0].deviceType._t, 'Thermostat');
    assert.equal(registered[1].deviceType._t, 'TemperatureSensor');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].clusterName, 'temperatureMeasurement');
    assert.equal(updates[0].attributes.measuredValue, 1950);
});

test('stale matter.js endpoint: second recovery attempt unregisters before re-registering (UUID preserved)', async () => {
    // Production scenario after the 32-char nodeLabel fix (2.1.3-rc.3): a previous
    // boot left an endpoint in matter.js with the over-limit displayName; new
    // register() succeeds but getAccessoryState() keeps returning undefined
    // because matter.js holds the stale record. The recovery path's second
    // attempt must purge the stale endpoint via unregister and then re-register.
    let registerCount = 0;
    const { api, registered, unregistered } = makeApi({
        registerImpl: (acc) => {
            registerCount += 1;
            // First two registers don't make the accessory queryable (stale state).
            // The third (after unregister) does.
            if (registerCount <= 2) return 'missing-state';
            return undefined;
        },
    });
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    // Use a non-thermostat device so the thermostat fallback path is bypassed.
    await registry.addOrUpdateAccessory({
        id: 'scenario_stale',
        type: 'scenario',
        name: 'Inserisci Tapparelle+Volumetrici',
        description: '',
        status: {},
    });
    await delay(FALLBACK_SETTLE_AND_UPDATE_FLUSH_MS);

    assert.equal(registry.getStatus('scenario_stale'), 'registered');
    assert.equal(registerCount, 3, 'three register calls: initial + recovery#1 + recovery#2-after-purge');
    assert.deepEqual(unregistered, ['scenario_stale'], 'recovery#2 must unregister the stale endpoint before re-registering');
    // UUID is preserved across all attempts — Apple Home rooms survive.
    for (const r of registered) assert.equal(r.UUID, 'scenario_stale');
});

test('register log includes sanitised displayName + length when name was sanitised', async () => {
    const logs = [];
    const log = { info: (m) => logs.push(m), warn: () => {}, debug: () => {}, error: () => {} };
    const { api } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log, getWsClient: () => undefined, storagePath: tmpStorage() });
    await registry.addOrUpdateAccessory({
        id: 'scenario_long',
        type: 'scenario',
        name: 'Inserisci Tapparelle+Volumetrici',
        description: '',
        status: {},
    });
    const registerLine = logs.find((l) => l.startsWith('[Matter] register requested:'));
    assert.ok(registerLine, 'register-request log line must be emitted');
    assert.ok(
        registerLine.includes('Inserisci Tapparelle e Volumetrici') || registerLine.includes('Inserisci Tapparelle'),
        `expected sanitised name in log: ${registerLine}`,
    );
    assert.match(registerLine, /\[\d+ch\]/, 'log must include the displayName length in chars');
    assert.match(registerLine, /uuid=scenario_long/, 'log must include the UUID');
});

test('rediscovery updates in-memory Matter identity without updatePlatformAccessories', async () => {
    const { api, metadataUpdates } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    await registry.addOrUpdateAccessory(lightDevice('light_meta'));
    await delay(200);
    metadataUpdates.length = 0;

    await registry.addOrUpdateAccessory(lightDevice('light_meta', { on: false }));
    assert.equal(metadataUpdates.length, 0, 'unchanged metadata should not rewrite the cache');

    await registry.addOrUpdateAccessory({
        ...lightDevice('light_meta', { on: false }),
        name: 'Luce Sala',
    });
    assert.equal(metadataUpdates.length, 0, 'metadata changes must not overwrite Homebridge internal endpoint state');
});

test('thermostat fallback: state updates go to temperatureMeasurement, not thermostat cluster', async () => {
    let rejectedOnce = false;
    const { api, updates } = makeApi({
        registerImpl: (acc) => {
            if (!rejectedOnce && acc.deviceType._t === 'Thermostat') {
                rejectedOnce = true;
                return 'throw';
            }
        },
    });
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    await registry.addOrUpdateAccessory(thermostatDevice('thermostat_70'));
    await delay(FALLBACK_SETTLE_AND_UPDATE_FLUSH_MS);
    updates.length = 0;
    await registry.updateAccessoryState(thermostatDevice('thermostat_70', { currentTemperature: 19.5 }));
    await delay(20);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].clusterName, 'temperatureMeasurement');
    assert.equal(updates[0].attributes.measuredValue, 1950);
});

test('failed device: no further attempts, no log spam', async () => {
    const { api, registered } = makeApi({
        registerImpl: () => 'throw',
    });
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    // Use a non-thermostat device (no fallback) to test the "failed" terminal state
    await registry.addOrUpdateAccessory(lightDevice('light_99'));
    assert.equal(registry.getStatus('light_99'), 'failed');
    const callsAfterFail = registered.length;
    // Subsequent updates must not retry
    await registry.updateAccessoryState(lightDevice('light_99'));
    await registry.addOrUpdateAccessory(lightDevice('light_99'));
    assert.equal(registered.length, callsAfterFail, 'no further register attempts after failure');
});

test('prune: unregisters devices no longer present in discovery cycle', async () => {
    const { api, unregistered } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(lightDevice('light_a'));
    await registry.addOrUpdateAccessory(lightDevice('light_b'));
    await delay(200); // settle both

    // New cycle — only light_a is rediscovered
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(lightDevice('light_a'));
    await registry.pruneStaleAccessories();

    assert.deepEqual(unregistered, ['light_b']);
    assert.equal(registry.getStatus('light_b'), undefined);
});
