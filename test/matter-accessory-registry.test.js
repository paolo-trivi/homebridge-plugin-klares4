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

test('prune: a single incomplete discovery cycle does NOT unregister a missing accessory', async () => {
    const { api, unregistered } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(lightDevice('light_a'));
    await registry.addOrUpdateAccessory(lightDevice('light_b'));
    await delay(200); // settle both

    // New cycle — only light_a is rediscovered (light_b missing for the first time)
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(lightDevice('light_a'));
    await registry.pruneStaleAccessories();

    assert.deepEqual(unregistered, [], 'a single missing cycle must never trigger unregister');
    assert.equal(registry.getStatus('light_b'), 'registered', 'accessory must remain registered after one missing cycle');
});

test('prune: stays skipped while missing cycles remain below the threshold', async () => {
    const { api, unregistered } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(lightDevice('light_a'));
    await registry.addOrUpdateAccessory(lightDevice('light_b'));
    await delay(200);

    // Two more consecutive cycles where light_b is missing (threshold is 3).
    for (let i = 0; i < 2; i++) {
        registry.startDiscoveryCycle();
        await registry.addOrUpdateAccessory(lightDevice('light_a'));
        await registry.pruneStaleAccessories();
    }

    assert.deepEqual(unregistered, [], 'below-threshold missing cycles must not unregister');
    assert.equal(registry.getStatus('light_b'), 'registered');
});

test('prune: unregisters only after N consecutive complete cycles where the device is missing', async () => {
    const { api, unregistered } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(lightDevice('light_a'));
    await registry.addOrUpdateAccessory(lightDevice('light_b'));
    await delay(200);

    // Three consecutive cycles where light_b is missing — this must cross the threshold.
    for (let i = 0; i < 3; i++) {
        registry.startDiscoveryCycle();
        await registry.addOrUpdateAccessory(lightDevice('light_a'));
        await registry.pruneStaleAccessories();
    }

    assert.deepEqual(unregistered, ['light_b'], 'unregister must fire exactly once, after the threshold is crossed');
    assert.equal(registry.getStatus('light_b'), undefined);

    // A further cycle must not unregister it again (it's already gone).
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(lightDevice('light_a'));
    await registry.pruneStaleAccessories();
    assert.deepEqual(unregistered, ['light_b'], 'no duplicate unregister calls for an already-removed accessory');
});

test('prune: missing-cycle counter resets when the device reappears before the threshold', async () => {
    const { api, unregistered } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(lightDevice('light_a'));
    await registry.addOrUpdateAccessory(lightDevice('light_b'));
    await delay(200);

    // light_b missing for 2 cycles (below the threshold of 3)...
    for (let i = 0; i < 2; i++) {
        registry.startDiscoveryCycle();
        await registry.addOrUpdateAccessory(lightDevice('light_a'));
        await registry.pruneStaleAccessories();
    }
    assert.deepEqual(unregistered, []);

    // ...then reappears.
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(lightDevice('light_a'));
    await registry.addOrUpdateAccessory(lightDevice('light_b'));
    await registry.pruneStaleAccessories();
    assert.deepEqual(unregistered, [], 'reappearance before threshold must not unregister');

    // Now it goes missing again for 2 more cycles — if the counter had NOT reset,
    // this would already total 4 missing cycles and cross the threshold.
    for (let i = 0; i < 2; i++) {
        registry.startDiscoveryCycle();
        await registry.addOrUpdateAccessory(lightDevice('light_a'));
        await registry.pruneStaleAccessories();
    }
    assert.deepEqual(unregistered, [], 'missing-cycle counter must have reset on reappearance');
    assert.equal(registry.getStatus('light_b'), 'registered');
});

test('two simulated boots: same device keeps UUID/serialNumber/displayName stable, no unregister, state still flows', async () => {
    // Two boots = two independent MatterAccessoryRegistry instances sharing the
    // same storagePath (mirrors a real Homebridge restart: a fresh plugin
    // instance, Homebridge's own accessory cache replayed via
    // configureCachedAccessory, then a fresh WS discovery cycle).
    const storagePath = tmpStorage();
    const device = lightDevice('light_boot');

    const boot1 = makeApi();
    const registry1 = new MatterAccessoryRegistry({ api: boot1.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    registry1.startDiscoveryCycle();
    await registry1.addOrUpdateAccessory(device);
    await delay(200);
    assert.equal(registry1.getStatus('light_boot'), 'registered');
    const firstRegistration = boot1.registered[0];

    const boot2 = makeApi();
    const registry2 = new MatterAccessoryRegistry({ api: boot2.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    registry2.configureCachedAccessory({ UUID: 'light_boot', displayName: firstRegistration.displayName });
    registry2.startDiscoveryCycle();
    await registry2.addOrUpdateAccessory(device);
    await delay(200);

    assert.equal(registry2.getStatus('light_boot'), 'registered');
    const secondRegistration = boot2.registered[0];
    assert.equal(secondRegistration.UUID, firstRegistration.UUID, 'UUID must survive across boots');
    assert.equal(secondRegistration.serialNumber, firstRegistration.serialNumber, 'serialNumber must survive across boots');
    assert.equal(secondRegistration.displayName, firstRegistration.displayName, 'displayName must survive across boots');
    assert.equal(boot2.unregistered.length, 0, 'a fresh boot rehydrating a known device must never unregister it');

    await registry2.pruneStaleAccessories();
    assert.equal(boot2.unregistered.length, 0, 'prune right after rehydration must not remove it');

    boot2.updates.length = 0;
    await registry2.updateAccessoryState({ ...device, status: { on: false, dimmable: false } });
    await delay(1200);
    assert.ok(boot2.updates.some((u) => u.uuid === 'light_boot'), 'state updates must still be accepted after rehydration');
});

// ---------------------------------------------------------------------------
// Two-phase name-map: deterministic voice names across boots (2.1.4-rc.6)
// ---------------------------------------------------------------------------

function zoneDevice(id, name) {
    return {
        id,
        type: 'zone',
        name,
        description: '',
        status: { armed: false, bypassed: false, fault: false, open: false },
    };
}

function coverDevice(id, name) {
    return {
        id,
        type: 'cover',
        name,
        description: '',
        status: { position: 0, state: 'stopped' },
    };
}

function capturingLog() {
    const lines = [];
    return {
        lines,
        log: {
            info: (...a) => lines.push(a.join(' ')),
            warn: (...a) => lines.push(a.join(' ')),
            debug: () => {},
            error: (...a) => lines.push(a.join(' ')),
        },
    };
}

test('name-map: first boot resolves the cover/zone collision at finalize; second boot registers final names immediately with zero metadata churn', async () => {
    const storagePath = tmpStorage();
    const zone = zoneDevice('zone_19', 'Finestra Cucina');
    const cover = coverDevice('cover_1', 'Finestra Cucina');

    // ---- Boot 1 (no persisted map yet): ZONES arrive before MULTI_TYPES ----
    const boot1 = makeApi();
    const registry1 = new MatterAccessoryRegistry({ api: boot1.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    registry1.startDiscoveryCycle();
    await registry1.addOrUpdateAccessory(zone);
    await registry1.addOrUpdateAccessory(cover);
    await delay(200);

    // Incremental fallback: the zone grabbed the clean name first.
    assert.equal(boot1.registered[0].displayName, 'Finestra Cucina');
    assert.equal(boot1.registered[1].displayName, 'Finestra Cucina');

    // Sync complete → batch name-map + targeted refresh of the outlier zone.
    await registry1.finalizeNameMap([zone, cover]);
    await delay(200);
    assert.deepEqual(boot1.unregistered, ['zone_19'], 'only the renamed zone is re-registered');
    const renamed = boot1.registered[2];
    assert.equal(renamed.UUID, 'zone_19');
    assert.equal(renamed.displayName, 'Finestra Cucina - Sens.');
    assert.equal(registry1.getStatus('zone_19'), 'registered');

    // ---- Boot 2 (map persisted): same discovery order, fresh process ----
    const boot2 = makeApi();
    const { lines, log } = capturingLog();
    const registry2 = new MatterAccessoryRegistry({ api: boot2.api, log, getWsClient: () => undefined, storagePath });
    registry2.startDiscoveryCycle();
    await registry2.addOrUpdateAccessory(zone);
    await registry2.addOrUpdateAccessory(cover);
    await delay(200);

    assert.equal(boot2.registered[0].displayName, 'Finestra Cucina - Sens.',
        'zone must register with its final suffixed name from the FIRST register call');
    assert.equal(boot2.registered[1].displayName, 'Finestra Cucina',
        'cover owns the clean voice name from the first instant');

    // Re-discovery pass (production re-emits devices during the same sync).
    await registry2.addOrUpdateAccessory(zone);
    await registry2.addOrUpdateAccessory(cover);

    await registry2.finalizeNameMap([zone, cover]);
    await delay(200);
    assert.equal(boot2.unregistered.length, 0, 'steady state: no renames, no unregisters');
    assert.equal(boot2.registered.length, 2, 'steady state: no extra register calls');

    await registry2.pruneStaleAccessories();
    const summary = lines.find((l) => l.includes('cycle #'));
    assert.ok(summary, 'cycle summary must be logged');
    assert.match(summary, /metadataChanged=0/, `expected zero metadata churn, got: ${summary}`);
    assert.match(summary, /unregistered=0/, `expected zero unregisters, got: ${summary}`);
    assert.match(summary, /metadataUnchanged=2/, `re-discovery must be recognised as unchanged, got: ${summary}`);

    // Acceptance: final name table is logged with the WARN-guard clean.
    assert.ok(lines.some((l) => l.includes('final name-map')), 'name table must be in the end-of-sync summary');
    assert.ok(!lines.some((l) => l.includes('DUPLICATE display name')), 'no duplicate names may survive');
});

test('name-map: discovery order does not matter once the map is persisted (covers-first boot after zones-first boot)', async () => {
    const storagePath = tmpStorage();
    const zone = zoneDevice('zone_18', 'Finestra Studio');
    const cover = coverDevice('cover_4', 'Finestra Studio');

    const boot1 = makeApi();
    const registry1 = new MatterAccessoryRegistry({ api: boot1.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    registry1.startDiscoveryCycle();
    await registry1.addOrUpdateAccessory(zone);
    await registry1.addOrUpdateAccessory(cover);
    await delay(200);
    await registry1.finalizeNameMap([zone, cover]);
    await delay(200);

    // Boot 2 flips the arrival order — the map must make it irrelevant.
    const boot2 = makeApi();
    const registry2 = new MatterAccessoryRegistry({ api: boot2.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    registry2.startDiscoveryCycle();
    await registry2.addOrUpdateAccessory(cover);
    await registry2.addOrUpdateAccessory(zone);
    await delay(200);

    const byUuid = Object.fromEntries(boot2.registered.map((r) => [r.UUID, r.displayName]));
    assert.equal(byUuid.cover_4, 'Finestra Studio');
    assert.equal(byUuid.zone_18, 'Finestra Studio - Sens.');
    assert.equal(boot2.unregistered.length, 0);
});

// ---------------------------------------------------------------------------
// matterExposure: per-type opt-out + prune discipline (2.1.4-rc.6)
// ---------------------------------------------------------------------------

test('matterExposure: disabled type is never registered, and status updates cannot sneak it back in', async () => {
    const { api, registered } = makeApi();
    const registry = new MatterAccessoryRegistry({
        api,
        log: silentLog(),
        getWsClient: () => undefined,
        storagePath: tmpStorage(),
        isDeviceExposed: (device) => device.type !== 'zone',
    });
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(zoneDevice('zone_1', 'Finestra Bagno'));
    await registry.addOrUpdateAccessory(lightDevice('light_1'));
    await delay(200);

    assert.equal(registered.length, 1, 'only the exposed light registers');
    assert.equal(registered[0].UUID, 'light_1');
    assert.equal(registry.getStatus('zone_1'), undefined);

    // The status-update path must be gated too (no register-on-update leak).
    await registry.updateAccessoryState(zoneDevice('zone_1', 'Finestra Bagno'));
    assert.equal(registered.length, 1, 'updateAccessoryState must not register a non-exposed device');
});

test('matterExposure: a registered type disabled later is pruned after 3 consecutive sync cycles', async () => {
    const { api, unregistered } = makeApi();
    let zonesExposed = true;
    const registry = new MatterAccessoryRegistry({
        api,
        log: silentLog(),
        getWsClient: () => undefined,
        storagePath: tmpStorage(),
        isDeviceExposed: (device) => device.type !== 'zone' || zonesExposed,
    });
    const zone = zoneDevice('zone_1', 'Finestra Bagno');

    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(zone);
    await registry.addOrUpdateAccessory(lightDevice('light_1'));
    await delay(200);
    assert.equal(registry.getStatus('zone_1'), 'registered');

    // User disables zones in matterExposure.
    zonesExposed = false;

    for (let cycle = 1; cycle <= 3; cycle++) {
        registry.startDiscoveryCycle();
        await registry.addOrUpdateAccessory(zone); // discovered but gated
        await registry.addOrUpdateAccessory(lightDevice('light_1'));
        await registry.pruneStaleAccessories();
        if (cycle < 3) {
            assert.deepEqual(unregistered, [], `cycle ${cycle}: below threshold, no unregister yet`);
        }
    }

    assert.deepEqual(unregistered, ['zone_1'], 'third consecutive cycle unregisters the disabled zone');
    assert.equal(registry.getStatus('zone_1'), undefined);
    assert.equal(registry.getStatus('light_1'), 'registered', 'exposed devices are untouched');
});

test('matterExposure: cached-only endpoints of a disabled type (config changed across restarts) are pruned in 3 cycles', async () => {
    const { api, registered, unregistered } = makeApi();
    const zombie = zoneDevice('zone_9', 'Porta Garage');
    const registry = new MatterAccessoryRegistry({
        api,
        log: silentLog(),
        getWsClient: () => undefined,
        storagePath: tmpStorage(),
        isDeviceExposed: (device) => device.type !== 'zone',
    });
    // Previous session registered the zone; this session only sees it in cache.
    registry.configureCachedAccessory({ UUID: 'zone_9', displayName: 'Porta Garage', context: { device: zombie } });

    for (let cycle = 1; cycle <= 3; cycle++) {
        registry.startDiscoveryCycle();
        await registry.addOrUpdateAccessory(lightDevice('light_1'));
        await registry.pruneStaleAccessories();
        if (cycle < 3) {
            assert.deepEqual(unregistered, [], `cycle ${cycle}: below threshold, cached zombie kept`);
        }
    }

    assert.deepEqual(unregistered, ['zone_9'], 'cached-only disabled-type endpoint removed on the third cycle');
    assert.ok(registered.every((r) => r.UUID !== 'zone_9'), 'the zombie was never re-registered');
});

// ---------------------------------------------------------------------------
// Conservative prune hardening (2.1.4 review)
// ---------------------------------------------------------------------------

test('prune: realtime status updates keep a device alive even when discovery misses it', async () => {
    const { api, unregistered } = makeApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage() });
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(lightDevice('light_a'));
    await registry.addOrUpdateAccessory(lightDevice('light_b'));
    await delay(200);

    // Four cycles where discovery misses light_b, but the device keeps
    // pushing realtime state — it is alive and must never be pruned.
    for (let i = 0; i < 4; i++) {
        registry.startDiscoveryCycle();
        await registry.addOrUpdateAccessory(lightDevice('light_a'));
        await registry.updateAccessoryState({ ...lightDevice('light_b'), status: { on: false, dimmable: false } });
        await registry.pruneStaleAccessories();
    }

    assert.deepEqual(unregistered, [], 'a device pushing state updates must never be pruned');
    assert.equal(registry.getStatus('light_b'), 'registered');
});

test('prune: missing-cycle counters persist across boots (stable setups run one cycle per boot)', async () => {
    const storagePath = tmpStorage();
    const zombie = zoneDevice('zone_9', 'Porta Garage');
    let lastBoot;

    // Production reality on a stable connection: ONE discovery + prune cycle
    // per boot. Each boot is a fresh registry instance; without persisted
    // counters the 3-cycle threshold could never be crossed across restarts.
    for (let boot = 1; boot <= 3; boot++) {
        const bootCtx = makeApi();
        const registry = new MatterAccessoryRegistry({
            api: bootCtx.api,
            log: silentLog(),
            getWsClient: () => undefined,
            storagePath,
            isDeviceExposed: (device) => device.type !== 'zone',
        });
        registry.configureCachedAccessory({ UUID: 'zone_9', displayName: 'Porta Garage', context: { device: zombie } });
        registry.startDiscoveryCycle();
        await registry.addOrUpdateAccessory(lightDevice('light_1'));
        await delay(200);
        await registry.pruneStaleAccessories();
        lastBoot = bootCtx;
        if (boot < 3) {
            assert.deepEqual(bootCtx.unregistered, [], `boot ${boot}: below threshold, cached zombie kept`);
        }
    }

    assert.deepEqual(lastBoot.unregistered, ['zone_9'], 'third boot crosses the persisted threshold and unregisters');
});

test('prune: persisted counter is cleared when the device reappears on a later boot', async () => {
    const storagePath = tmpStorage();
    const zone = zoneDevice('zone_5', 'Finestra Bagno');
    let zonesExposed = false;
    const exposure = (device) => device.type !== 'zone' || zonesExposed;

    // Boot 1+2: zone disabled → two persisted misses.
    for (let boot = 1; boot <= 2; boot++) {
        const bootCtx = makeApi();
        const registry = new MatterAccessoryRegistry({
            api: bootCtx.api, log: silentLog(), getWsClient: () => undefined, storagePath, isDeviceExposed: exposure,
        });
        registry.configureCachedAccessory({ UUID: 'zone_5', displayName: 'Finestra Bagno', context: { device: zone } });
        registry.startDiscoveryCycle();
        await registry.addOrUpdateAccessory(lightDevice('light_1'));
        await delay(200);
        await registry.pruneStaleAccessories();
        assert.deepEqual(bootCtx.unregistered, [], `boot ${boot}: below threshold`);
    }

    // Boot 3: user re-enables zones → device is discovered again, counter resets.
    zonesExposed = true;
    const boot3 = makeApi();
    const registry3 = new MatterAccessoryRegistry({
        api: boot3.api, log: silentLog(), getWsClient: () => undefined, storagePath, isDeviceExposed: exposure,
    });
    registry3.configureCachedAccessory({ UUID: 'zone_5', displayName: 'Finestra Bagno', context: { device: zone } });
    registry3.startDiscoveryCycle();
    await registry3.addOrUpdateAccessory(zone);
    await registry3.addOrUpdateAccessory(lightDevice('light_1'));
    await delay(200);
    await registry3.pruneStaleAccessories();
    assert.deepEqual(boot3.unregistered, [], 'reappeared device must not be unregistered');

    // Boot 4: disabled again → must start counting from 1, not resume from 2.
    zonesExposed = false;
    const boot4 = makeApi();
    const registry4 = new MatterAccessoryRegistry({
        api: boot4.api, log: silentLog(), getWsClient: () => undefined, storagePath, isDeviceExposed: exposure,
    });
    registry4.configureCachedAccessory({ UUID: 'zone_5', displayName: 'Finestra Bagno', context: { device: zone } });
    registry4.startDiscoveryCycle();
    await registry4.addOrUpdateAccessory(lightDevice('light_1'));
    await delay(200);
    await registry4.pruneStaleAccessories();
    assert.deepEqual(boot4.unregistered, [], 'counter must have restarted after the reappearance');
});
