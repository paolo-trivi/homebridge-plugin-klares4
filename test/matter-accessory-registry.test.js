const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '1000';
// Speed up probe-based settle in tests
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '10';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '20';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '20';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { makeHbMatterApi, deviceTypes } = require('./fixtures/hb-matter-api.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

function silentLog() {
    return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
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
        name: 'Riscaldamento Veranda',
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

test('does not crash when api.matter is undefined', async (t) => {
    const api = { matter: undefined };
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    assert.equal(registry.isEnabled, false);
    await registry.addOrUpdateAccessory(lightDevice());
    await registry.updateAccessoryState(lightDevice());
    await registry.pruneStaleAccessories();
    // Nothing should throw, and no state should be tracked.
    assert.equal(registry.getStatus('light_1'), undefined);
});

test('addOrUpdateAccessory: register → pending → settled → registered', async (t) => {
    const { api, registerCalls: registered, metadataUpdates } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    await registry.addOrUpdateAccessory(lightDevice());
    assert.equal(registered.length, 1);
    assert.equal(registry.getStatus('light_1'), 'pending');
    await delay(200); // > MATTER_REGISTER_SETTLE_MS
    await waitFor(() => registry.getStatus('light_1') === 'registered');
    assert.equal(registry.getStatus('light_1'), 'registered');
    assert.equal(metadataUpdates.length, 0, 'must not call updatePlatformAccessories because it drops endpoints in HB2');
    assert.equal(registered[0].manufacturer, 'Ksenia');
    assert.equal(registered[0].model, 'Lares4 light');
    assert.equal(registered[0].serialNumber, 'light_1');
    assert.match(registered[0].firmwareRevision, /^\d+\.\d+\.\d+$/);
});

test('status updates received during the settle window are queued, not pushed', async (t) => {
    const { api, updates } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    await registry.addOrUpdateAccessory(lightDevice('light_2'));
    assert.equal(registry.getStatus('light_2'), 'pending');
    assert.equal(updates.length, 0);
    await registry.updateAccessoryState({ ...lightDevice('light_2'), status: { on: false, dimmable: false } });
    assert.equal(updates.length, 0, 'updateAccessoryState must not be called during settle');
    assert.equal(registry.getPendingCount('light_2'), 1, 'state should be queued');
});

test('queued updates are flushed after the settle window', async (t) => {
    const { api, updates } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    await registry.addOrUpdateAccessory(lightDevice('light_3'));
    await registry.updateAccessoryState({ ...lightDevice('light_3'), status: { on: false, dimmable: false } });
    assert.equal(updates.length, 0);
    await delay(SETTLE_AND_UPDATE_FLUSH_MS);
    assert.ok(updates.length >= 1, 'queued update should be flushed after settle');
    assert.equal(updates[0].uuid, 'light_3');
    assert.equal(updates[0].cluster, 'onOff');
    assert.deepEqual(updates[0].attributes, { onOff: false });
});

test('queue dedupes by (clusterName, partId): only latest payload is kept', async (t) => {
    const { api, updates } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    await registry.addOrUpdateAccessory(lightDevice('light_4'));
    // Three updates for the same cluster — only the last one should remain queued
    await registry.updateAccessoryState({ ...lightDevice('light_4'), status: { on: false, dimmable: false } });
    await registry.updateAccessoryState({ ...lightDevice('light_4'), status: { on: true, dimmable: false } });
    await registry.updateAccessoryState({ ...lightDevice('light_4'), status: { on: false, dimmable: false } });
    assert.equal(registry.getPendingCount('light_4'), 1);
    await delay(SETTLE_AND_UPDATE_FLUSH_MS);
    const onOffUpdates = updates.filter((u) => u.uuid === 'light_4' && u.cluster === 'onOff');
    assert.equal(onOffUpdates.length, 1);
    assert.deepEqual(onOffUpdates[0].attributes, { onOff: false });
});

test('post-settle: updates are pushed immediately', async (t) => {
    const { api, updates } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    await registry.addOrUpdateAccessory(lightDevice('light_5'));
    await delay(SETTLE_AND_UPDATE_FLUSH_MS); // settle + state update bootstrap
    updates.length = 0;
    await registry.updateAccessoryState({ ...lightDevice('light_5'), status: { on: false, dimmable: false } });
    await delay(20); // post-bootstrap flush still goes through the queue's setTimeout(0)
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].attributes, { onOff: false });
});

test('thermostat: registers as Thermostat when matter accepts it', async (t) => {
    const { api, registerCalls: registered } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    await registry.addOrUpdateAccessory(thermostatDevice('thermostat_50'));
    await delay(200);
    await waitFor(() => registry.getStatus('thermostat_50') === 'registered');
    assert.equal(registry.getStatus('thermostat_50'), 'registered');
    assert.equal(registered[0].deviceType, 'Thermostat');
});

test('thermostat: falls back to TemperatureSensor when Homebridge refuses the Thermostat endpoint', async (t) => {
    // Homebridge 2.5 only logs a refused endpoint (e.g. a matter.js conformance
    // error): the register call resolves and the probe finds nothing. Both
    // Thermostat payloads are refused (TH-01: the 2.2.0 one is tried second).
    const hb = makeHbMatterApi({
        failRegistration: (acc) => acc.deviceType.name === 'Thermostat',
    });
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    await registry.addOrUpdateAccessory(thermostatDevice('thermostat_60'));
    await waitFor(() => registry.getStatus('thermostat_60') === 'registered', FALLBACK_SETTLE_AND_UPDATE_FLUSH_MS);
    assert.deepEqual(hb.registerCalls.map((r) => r.deviceType), ['Thermostat', 'Thermostat', 'TemperatureSensor']);
    assert.equal(hb.endpoints.get('thermostat_60').deviceType.name, 'TemperatureSensor');
});

test('thermostat: async missing registration falls back before state updates', async (t) => {
    // Neither Thermostat payload answers (TH-01: the second attempt comes before the fallback).
    const { api, registerCalls: registered, updates } = makeHbMatterApi({ unqueryableTimes: { thermostat_async_missing: 2 } });
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    await registry.addOrUpdateAccessory(thermostatDevice('thermostat_async_missing'));
    await registry.updateAccessoryState(thermostatDevice('thermostat_async_missing', { currentTemperature: 19.5 }));
    await delay(FALLBACK_SETTLE_AND_UPDATE_FLUSH_MS);

    await waitFor(() => registry.getStatus('thermostat_async_missing') === 'registered');
    assert.equal(registry.getStatus('thermostat_async_missing'), 'registered');
    assert.deepEqual(registered.map((r) => r.deviceType), ['Thermostat', 'Thermostat', 'TemperatureSensor']);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].cluster, 'temperatureMeasurement');
    assert.equal(updates[0].attributes.measuredValue, 1950);
});

test('stale matter.js endpoint: every recovery attempt unregisters before re-registering (UUID preserved)', async (t) => {
    // Production scenario after the 32-char nodeLabel fix (2.1.3-rc.3): a previous
    // boot left an endpoint in matter.js with the over-limit displayName; new
    // register() succeeds but getAccessoryState() keeps returning undefined
    // because matter.js holds the stale record. The recovery path's second
    // attempts purge the stale endpoint via unregister and then re-register
    // (Homebridge rejects a register of a UUID it still holds).
    // The first two endpoints don't answer reads (stale state); the third,
    // registered after an unregister, does.
    const { api, registerCalls: registered, unregisterCalls: unregistered } = makeHbMatterApi({
        unqueryableTimes: { scenario_stale: 2 },
    });
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    // Use a non-thermostat device so the thermostat fallback path is bypassed.
    await registry.addOrUpdateAccessory({
        id: 'scenario_stale',
        type: 'scenario',
        name: 'Inserisci Tapparelle+Volumetrici',
        description: '',
        status: {},
    });
    await delay(FALLBACK_SETTLE_AND_UPDATE_FLUSH_MS);

    await waitFor(() => registry.getStatus('scenario_stale') === 'registered');
    assert.equal(registry.getStatus('scenario_stale'), 'registered');
    assert.equal(registered.length, 3, 'three register calls: initial + recovery#1 + recovery#2-after-purge');
    assert.deepEqual(unregistered, ['scenario_stale', 'scenario_stale'], 'each recovery attempt unregisters before re-registering');
    // UUID is preserved across all attempts — Apple Home rooms survive.
    for (const r of registered) assert.equal(r.UUID, 'scenario_stale');
});

test('register log includes sanitised displayName + length when name was sanitised', async (t) => {
    const logs = [];
    const log = { info: (m) => logs.push(m), warn: () => {}, debug: () => {}, error: () => {} };
    const { api } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api, log, getWsClient: () => undefined, storagePath: tmpStorage(t) });
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

test('rediscovery updates in-memory Matter identity without updatePlatformAccessories', async (t) => {
    const { api, metadataUpdates } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    await registry.addOrUpdateAccessory(lightDevice('light_meta'));
    await delay(200);
    metadataUpdates.length = 0;

    await registry.addOrUpdateAccessory(lightDevice('light_meta', { on: false }));
    assert.equal(metadataUpdates.length, 0, 'unchanged metadata should not rewrite the cache');

    await registry.addOrUpdateAccessory({
        ...lightDevice('light_meta', { on: false }),
        name: 'Luce Veranda',
    });
    assert.equal(metadataUpdates.length, 0, 'metadata changes must not overwrite Homebridge internal endpoint state');
});

test('thermostat fallback: state updates go to temperatureMeasurement, not thermostat cluster', async (t) => {
    const { api, updates } = makeHbMatterApi({
        failRegistration: (acc) => acc.deviceType.name === 'Thermostat',
    });
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    await registry.addOrUpdateAccessory(thermostatDevice('thermostat_70'));
    await delay(FALLBACK_SETTLE_AND_UPDATE_FLUSH_MS);
    updates.length = 0;
    await registry.updateAccessoryState(thermostatDevice('thermostat_70', { currentTemperature: 19.5 }));
    await delay(20);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].cluster, 'temperatureMeasurement');
    assert.equal(updates[0].attributes.measuredValue, 1950);
});

test('failed device: no further attempts, no log spam', async (t) => {
    // The register call itself rejects (here: no Matter manager attached,
    // MatterAPIImpl.assertMatterReady), which is not a transient condition.
    const { api, registerCalls: registered } = makeHbMatterApi({ matterReady: false });
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
    // Use a non-thermostat device (no fallback) to test the "failed" terminal state
    await registry.addOrUpdateAccessory(lightDevice('light_99'));
    assert.equal(registry.getStatus('light_99'), 'failed');
    const callsAfterFail = registered.length;
    // Subsequent updates must not retry
    await registry.updateAccessoryState(lightDevice('light_99'));
    await registry.addOrUpdateAccessory(lightDevice('light_99'));
    assert.equal(registered.length, callsAfterFail, 'no further register attempts after failure');
});

test('prune: a single incomplete discovery cycle does NOT unregister a missing accessory', async (t) => {
    const { api, unregisterCalls: unregistered } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
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

test('prune: stays skipped while missing cycles remain below the threshold', async (t) => {
    const { api, unregisterCalls: unregistered } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
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

test('prune: unregisters only after N consecutive complete cycles where the device is missing', async (t) => {
    const { api, unregisterCalls: unregistered } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
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

test('prune: missing-cycle counter resets when the device reappears before the threshold', async (t) => {
    const { api, unregisterCalls: unregistered } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
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

test('two simulated boots: same device keeps UUID/serialNumber/displayName stable, no unregister, state still flows', async (t) => {
    // Two boots = two independent MatterAccessoryRegistry instances sharing the
    // same storagePath (mirrors a real Homebridge restart: a fresh plugin
    // instance, Homebridge's own accessory cache replayed via
    // configureCachedAccessory, then a fresh WS discovery cycle).
    const storagePath = tmpStorage(t);
    const device = lightDevice('light_boot');

    const boot1 = makeHbMatterApi();
    const registry1 = new MatterAccessoryRegistry({ api: boot1.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    registry1.startDiscoveryCycle();
    await registry1.addOrUpdateAccessory(device);
    await delay(200);
    await waitFor(() => registry1.getStatus('light_boot') === 'registered');
    assert.equal(registry1.getStatus('light_boot'), 'registered');
    const firstRegistration = boot1.registerCalls[0];

    const boot2 = makeHbMatterApi({ restored: boot1.cacheSnapshot() });
    const registry2 = new MatterAccessoryRegistry({ api: boot2.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    registry2.configureCachedAccessory({ UUID: 'light_boot', displayName: firstRegistration.displayName });
    registry2.startDiscoveryCycle();
    await registry2.addOrUpdateAccessory(device);
    await delay(200);

    await waitFor(() => registry2.getStatus('light_boot') === 'registered');
    assert.equal(registry2.getStatus('light_boot'), 'registered');
    const secondRegistration = boot2.registerCalls[0];
    assert.equal(secondRegistration.UUID, firstRegistration.UUID, 'UUID must survive across boots');
    assert.equal(secondRegistration.serialNumber, firstRegistration.serialNumber, 'serialNumber must survive across boots');
    assert.equal(secondRegistration.displayName, firstRegistration.displayName, 'displayName must survive across boots');
    assert.equal(boot2.unregisterCalls.length, 0, 'a fresh boot rehydrating a known device must never unregister it');

    await registry2.pruneStaleAccessories();
    assert.equal(boot2.unregisterCalls.length, 0, 'prune right after rehydration must not remove it');

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

// What Homebridge restores from its Matter cache for a zone registered by a
// previous session, and what it hands to configureMatterAccessory.
function cachedZone(id, name, device) {
    return {
        restored: { UUID: id, displayName: name, deviceType: deviceTypes.ContactSensor, clusters: { booleanState: { stateValue: true } } },
        cached: { UUID: id, displayName: name, deviceType: { name: 'ContactSensor', code: 21 }, context: { device } },
    };
}

test('name-map: first boot resolves the cover/zone collision at finalize; second boot registers final names immediately with zero metadata churn', async (t) => {
    const storagePath = tmpStorage(t);
    const zone = zoneDevice('zone_19', 'Finestra Taverna');
    const cover = coverDevice('cover_1', 'Finestra Taverna');

    // ---- Boot 1 (no persisted map yet): ZONES arrive before MULTI_TYPES ----
    const boot1 = makeHbMatterApi();
    const registry1 = new MatterAccessoryRegistry({ api: boot1.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    registry1.startDiscoveryCycle();
    await registry1.addOrUpdateAccessory(zone);
    await registry1.addOrUpdateAccessory(cover);
    await delay(200);

    // Incremental fallback: the zone grabbed the clean name first.
    assert.equal(boot1.registerCalls[0].displayName, 'Finestra Taverna');
    assert.equal(boot1.registerCalls[1].displayName, 'Finestra Taverna');

    // Sync complete → batch name-map + targeted refresh of the outlier zone.
    await registry1.finalizeNameMap([zone, cover]);
    await delay(200);
    assert.deepEqual(boot1.unregisterCalls, ['zone_19'], 'only the renamed zone is re-registered');
    const renamed = boot1.registerCalls[2];
    assert.equal(renamed.UUID, 'zone_19');
    assert.equal(renamed.displayName, 'Finestra Taverna - Sens.');
    assert.equal(registry1.getStatus('zone_19'), 'registered');

    // ---- Boot 2 (map persisted): same discovery order, fresh process ----
    const boot2 = makeHbMatterApi({ restored: boot1.cacheSnapshot() });
    const { lines, log } = capturingLog();
    const registry2 = new MatterAccessoryRegistry({ api: boot2.api, log, getWsClient: () => undefined, storagePath });
    registry2.startDiscoveryCycle();
    await registry2.addOrUpdateAccessory(zone);
    await registry2.addOrUpdateAccessory(cover);
    await delay(200);

    assert.equal(boot2.registerCalls[0].displayName, 'Finestra Taverna - Sens.',
        'zone must register with its final suffixed name from the FIRST register call');
    assert.equal(boot2.registerCalls[1].displayName, 'Finestra Taverna',
        'cover owns the clean voice name from the first instant');

    // Re-discovery pass (production re-emits devices during the same sync).
    await registry2.addOrUpdateAccessory(zone);
    await registry2.addOrUpdateAccessory(cover);

    await registry2.finalizeNameMap([zone, cover]);
    await delay(200);
    assert.equal(boot2.unregisterCalls.length, 0, 'steady state: no renames, no unregisters');
    assert.equal(boot2.registerCalls.length, 2, 'steady state: no extra register calls');

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

test('name-map: discovery order does not matter once the map is persisted (covers-first boot after zones-first boot)', async (t) => {
    const storagePath = tmpStorage(t);
    const zone = zoneDevice('zone_18', 'Finestra Solaio');
    const cover = coverDevice('cover_4', 'Finestra Solaio');

    const boot1 = makeHbMatterApi();
    const registry1 = new MatterAccessoryRegistry({ api: boot1.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    registry1.startDiscoveryCycle();
    await registry1.addOrUpdateAccessory(zone);
    await registry1.addOrUpdateAccessory(cover);
    await delay(200);
    await registry1.finalizeNameMap([zone, cover]);
    await delay(200);

    // Boot 2 flips the arrival order — the map must make it irrelevant.
    const boot2 = makeHbMatterApi({ restored: boot1.cacheSnapshot() });
    const registry2 = new MatterAccessoryRegistry({ api: boot2.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    registry2.startDiscoveryCycle();
    await registry2.addOrUpdateAccessory(cover);
    await registry2.addOrUpdateAccessory(zone);
    await delay(200);

    const byUuid = Object.fromEntries(boot2.registerCalls.map((r) => [r.UUID, r.displayName]));
    assert.equal(byUuid.cover_4, 'Finestra Solaio');
    assert.equal(byUuid.zone_18, 'Finestra Solaio - Sens.');
    assert.equal(boot2.unregisterCalls.length, 0);
});

// ---------------------------------------------------------------------------
// matterExposure: per-type opt-out + prune discipline (2.1.4-rc.6)
// ---------------------------------------------------------------------------

test('matterExposure: disabled type is never registered, and status updates cannot sneak it back in', async (t) => {
    const { api, registerCalls: registered } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({
        api,
        log: silentLog(),
        getWsClient: () => undefined,
        storagePath: tmpStorage(t),
        isDeviceExposed: (device) => device.type !== 'zone',
    });
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(zoneDevice('zone_1', 'Finestra Atrio'));
    await registry.addOrUpdateAccessory(lightDevice('light_1'));
    await delay(200);

    assert.equal(registered.length, 1, 'only the exposed light registers');
    assert.equal(registered[0].UUID, 'light_1');
    assert.equal(registry.getStatus('zone_1'), undefined);

    // The status-update path must be gated too (no register-on-update leak).
    await registry.updateAccessoryState(zoneDevice('zone_1', 'Finestra Atrio'));
    assert.equal(registered.length, 1, 'updateAccessoryState must not register a non-exposed device');
});

test('matterExposure: a registered type disabled later is pruned after 3 consecutive sync cycles', async (t) => {
    const { api, unregisterCalls: unregistered } = makeHbMatterApi();
    let zonesExposed = true;
    const registry = new MatterAccessoryRegistry({
        api,
        log: silentLog(),
        getWsClient: () => undefined,
        storagePath: tmpStorage(t),
        isDeviceExposed: (device) => device.type !== 'zone' || zonesExposed,
    });
    const zone = zoneDevice('zone_1', 'Finestra Atrio');

    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(zone);
    await registry.addOrUpdateAccessory(lightDevice('light_1'));
    await delay(200);
    await waitFor(() => registry.getStatus('zone_1') === 'registered');
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

test('matterExposure: cached-only endpoints of a disabled type (config changed across restarts) are pruned in 3 cycles', async (t) => {
    const zombie = zoneDevice('zone_9', 'Porta Garage');
    const cache = cachedZone('zone_9', 'Porta Garage', zombie);
    const { api, registerCalls: registered, unregisterCalls: unregistered } = makeHbMatterApi({ restored: [cache.restored] });
    const registry = new MatterAccessoryRegistry({
        api,
        log: silentLog(),
        getWsClient: () => undefined,
        storagePath: tmpStorage(t),
        isDeviceExposed: (device) => device.type !== 'zone',
    });
    // Previous session registered the zone; this session only sees it in cache.
    registry.configureCachedAccessory(cache.cached);

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

test('prune: realtime status updates keep a device alive even when discovery misses it', async (t) => {
    const { api, unregisterCalls: unregistered } = makeHbMatterApi();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => undefined, storagePath: tmpStorage(t) });
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

test('prune: missing-cycle counters persist across boots (stable setups run one cycle per boot)', async (t) => {
    const storagePath = tmpStorage(t);
    const zombie = zoneDevice('zone_9', 'Porta Garage');
    let lastBoot;

    // Production reality on a stable connection: ONE discovery + prune cycle
    // per boot. Each boot is a fresh registry instance; without persisted
    // counters the 3-cycle threshold could never be crossed across restarts.
    for (let boot = 1; boot <= 3; boot++) {
        const cache = cachedZone('zone_9', 'Porta Garage', zombie);
        const bootCtx = makeHbMatterApi({ restored: [cache.restored] });
        const registry = new MatterAccessoryRegistry({
            api: bootCtx.api,
            log: silentLog(),
            getWsClient: () => undefined,
            storagePath,
            isDeviceExposed: (device) => device.type !== 'zone',
        });
        registry.configureCachedAccessory(cache.cached);
        registry.startDiscoveryCycle();
        await registry.addOrUpdateAccessory(lightDevice('light_1'));
        await delay(200);
        await registry.pruneStaleAccessories();
        lastBoot = bootCtx;
        if (boot < 3) {
            assert.deepEqual(bootCtx.unregisterCalls, [], `boot ${boot}: below threshold, cached zombie kept`);
        }
    }

    assert.deepEqual(lastBoot.unregisterCalls, ['zone_9'], 'third boot crosses the persisted threshold and unregisters');
});

test('prune: persisted counter is cleared when the device reappears on a later boot', async (t) => {
    const storagePath = tmpStorage(t);
    const zone = zoneDevice('zone_5', 'Finestra Atrio');
    const cache = cachedZone('zone_5', 'Finestra Atrio', zone);
    let zonesExposed = false;
    const exposure = (device) => device.type !== 'zone' || zonesExposed;

    // Boot 1+2: zone disabled → two persisted misses.
    for (let boot = 1; boot <= 2; boot++) {
        const bootCtx = makeHbMatterApi({ restored: [cache.restored] });
        const registry = new MatterAccessoryRegistry({
            api: bootCtx.api, log: silentLog(), getWsClient: () => undefined, storagePath, isDeviceExposed: exposure,
        });
        registry.configureCachedAccessory(cache.cached);
        registry.startDiscoveryCycle();
        await registry.addOrUpdateAccessory(lightDevice('light_1'));
        await delay(200);
        await registry.pruneStaleAccessories();
        assert.deepEqual(bootCtx.unregisterCalls, [], `boot ${boot}: below threshold`);
    }

    // Boot 3: user re-enables zones → device is discovered again, counter resets.
    zonesExposed = true;
    const boot3 = makeHbMatterApi({ restored: [cache.restored] });
    const registry3 = new MatterAccessoryRegistry({
        api: boot3.api, log: silentLog(), getWsClient: () => undefined, storagePath, isDeviceExposed: exposure,
    });
    registry3.configureCachedAccessory(cache.cached);
    registry3.startDiscoveryCycle();
    await registry3.addOrUpdateAccessory(zone);
    await registry3.addOrUpdateAccessory(lightDevice('light_1'));
    await delay(200);
    await registry3.pruneStaleAccessories();
    assert.deepEqual(boot3.unregisterCalls, [], 'reappeared device must not be unregistered');

    // Boot 4: disabled again → must start counting from 1, not resume from 2.
    zonesExposed = false;
    const boot4 = makeHbMatterApi({ restored: [cache.restored] });
    const registry4 = new MatterAccessoryRegistry({
        api: boot4.api, log: silentLog(), getWsClient: () => undefined, storagePath, isDeviceExposed: exposure,
    });
    registry4.configureCachedAccessory(cache.cached);
    registry4.startDiscoveryCycle();
    await registry4.addOrUpdateAccessory(lightDevice('light_1'));
    await delay(200);
    await registry4.pruneStaleAccessories();
    assert.deepEqual(boot4.unregisterCalls, [], 'counter must have restarted after the reappearance');
});

test('explicit thermostat recovery keeps the device ID and records native success', async (t) => {
    const storagePath = tmpStorage(t);
    fs.writeFileSync(path.join(storagePath, 'klares4-matter-fallback.json'), JSON.stringify({
        thermostatAsTemperatureSensor: ['thermostat_18'],
    }));
    // The previous session's fallback endpoint, restored by Homebridge.
    const { api, registerCalls: registered, unregisterCalls: unregistered } = makeHbMatterApi({
        restored: [{ UUID: 'thermostat_18', displayName: 'Riscaldamento Veranda', deviceType: deviceTypes.TemperatureSensor,
            clusters: { temperatureMeasurement: { measuredValue: 2100 } } }],
    });
    const registry = new MatterAccessoryRegistry({
        api,
        log: silentLog(),
        getWsClient: () => undefined,
        storagePath,
        recoveryRequests: { thermostat_18: 1 },
    });
    // Homebridge hands the cached endpoint to configureMatterAccessory first.
    registry.configureCachedAccessory({
        UUID: 'thermostat_18',
        displayName: 'Riscaldamento Veranda',
        deviceType: { name: 'TemperatureSensor', code: 770 },
        context: { device: thermostatDevice() },
    });

    await registry.addOrUpdateAccessory(thermostatDevice());
    await waitFor(() => registry.getStatus('thermostat_18') === 'registered');

    assert.deepEqual(unregistered, ['thermostat_18']);
    assert.equal(registered[0].UUID, 'thermostat_18');
    assert.equal(registered[0].deviceType, 'Thermostat');
    const saved = JSON.parse(fs.readFileSync(path.join(storagePath, 'klares4-matter-fallback.json')));
    assert.equal(saved.thermostats[0].mode, 'native');
    assert.equal(saved.thermostats[0].lastProcessedRecoveryRequest, 1);
});

test('failed explicit thermostat recovery rolls back once to TemperatureSensor', async (t) => {
    const storagePath = tmpStorage(t);
    fs.writeFileSync(path.join(storagePath, 'klares4-matter-fallback.json'), JSON.stringify({
        thermostatAsTemperatureSensor: ['thermostat_18'],
    }));
    // Homebridge refuses the Thermostat endpoint every time (logged only).
    const { api, registerCalls: registered } = makeHbMatterApi({
        failRegistration: (accessory) => accessory.deviceType.name === 'Thermostat',
    });
    const registry = new MatterAccessoryRegistry({
        api,
        log: silentLog(),
        getWsClient: () => undefined,
        storagePath,
        recoveryRequests: { thermostat_18: 1 },
    });

    await registry.addOrUpdateAccessory(thermostatDevice());
    await waitFor(() => registered.at(-1)?.deviceType === 'TemperatureSensor'
        && registry.getStatus('thermostat_18') === 'registered', FALLBACK_SETTLE_AND_UPDATE_FLUSH_MS);

    const saved = JSON.parse(fs.readFileSync(path.join(storagePath, 'klares4-matter-fallback.json')));
    assert.equal(saved.thermostats[0].mode, 'fallback');
    assert.equal(saved.thermostats[0].lastProcessedRecoveryRequest, 1);
});

test('explicit thermostat recovery removes a cache-restored fallback endpoint (unregister reads deviceType.deviceType)', async (t) => {
    const storagePath = tmpStorage(t);
    fs.writeFileSync(path.join(storagePath, 'klares4-matter-fallback.json'), JSON.stringify({
        thermostatAsTemperatureSensor: ['thermostat_18'],
    }));
    // Homebridge restored the fallback endpoint from its cache; its unregister
    // dereferences `accessory.deviceType.deviceType` before removing anything.
    const { api, registerCalls: registered } = makeHbMatterApi({
        restored: [{ UUID: 'thermostat_18', displayName: 'Riscaldamento Veranda', deviceType: deviceTypes.TemperatureSensor,
            clusters: { temperatureMeasurement: { measuredValue: 2100 } } }],
    });
    const registry = new MatterAccessoryRegistry({
        api,
        log: silentLog(),
        getWsClient: () => undefined,
        storagePath,
        recoveryRequests: { thermostat_18: 1 },
    });
    registry.configureCachedAccessory({
        UUID: 'thermostat_18',
        displayName: 'Riscaldamento Veranda',
        deviceType: { name: 'TemperatureSensor', code: 770 },
        context: { device: thermostatDevice() },
    });

    await registry.addOrUpdateAccessory(thermostatDevice());
    await delay(250);

    assert.equal(registered.at(-1).deviceType, 'Thermostat');
    const saved = JSON.parse(fs.readFileSync(path.join(storagePath, 'klares4-matter-fallback.json')));
    assert.equal(saved.thermostats[0].mode, 'native');
});
