const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '50';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '10';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '20';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '20';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { makeHbMatterApi, deviceTypes } = require('./fixtures/hb-matter-api.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');
const { waitFor } = require('./fixtures/wait-for.js');

function silentLog() {
    return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function thermostat(extras = {}) {
    return {
        id: 'thermostat_18',
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

function storageWithFallback(t) {
    const dir = tmpStorage(t, 'klares4-race-');
    fs.writeFileSync(path.join(dir, 'klares4-matter-fallback.json'), JSON.stringify({
        thermostatAsTemperatureSensor: ['thermostat_18'],
    }));
    return dir;
}

function recoveryRegistry(api, storagePath) {
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
        deviceType: deviceTypes.TemperatureSensor,
        clusters: { temperatureMeasurement: { measuredValue: 2100 } },
        context: { device: thermostat() },
    });
    return registry;
}

test('F05: a state update during thermostat recovery joins the in-flight registration instead of registering twice', async (t) => {
    const storagePath = storageWithFallback(t);
    const hb = makeHbMatterApi({
        restored: [{
            UUID: 'thermostat_18',
            deviceType: deviceTypes.TemperatureSensor,
            clusters: { temperatureMeasurement: {} },
        }],
    });
    const registry = recoveryRegistry(hb.api, storagePath);

    // Discovery starts the recovery (unregister of the cache-restored fallback);
    // CFG_THERMOSTATS / STATUS_* arrive a few ms later, as on a real panel.
    const discovery = registry.addOrUpdateAccessory(thermostat());
    await delay(5);
    const status = registry.updateAccessoryState(thermostat({ currentTemperature: 21.5 }));
    await Promise.all([discovery, status]);
    await delay(400);

    assert.deepEqual(hb.log, [], 'Homebridge must not reject a duplicate registration');
    assert.equal(hb.registerCalls.length, 1, 'exactly one register call for the device');
    assert.equal(hb.registerCalls[0].deviceType, 'Thermostat');
    assert.equal(hb.endpoints.get('thermostat_18').deviceType.name, 'Thermostat');
    assert.equal(registry.getStatus('thermostat_18'), 'registered');
    const saved = JSON.parse(fs.readFileSync(path.join(storagePath, 'klares4-matter-fallback.json')));
    assert.equal(saved.thermostats[0].mode, 'native');
});

test('F05: the joined update is still delivered once the registration settles', async (t) => {
    const storagePath = storageWithFallback(t);
    const hb = makeHbMatterApi({
        restored: [{
            UUID: 'thermostat_18',
            deviceType: deviceTypes.TemperatureSensor,
            clusters: { temperatureMeasurement: {} },
        }],
    });
    const registry = recoveryRegistry(hb.api, storagePath);

    const discovery = registry.addOrUpdateAccessory(thermostat());
    await delay(5);
    const status = registry.updateAccessoryState(thermostat({ currentTemperature: 23.5 }));
    await Promise.all([discovery, status]);
    await delay(600);

    const temps = hb.updates
        .filter((u) => u.uuid === 'thermostat_18' && u.cluster === 'thermostat')
        .map((u) => u.attributes.localTemperature)
        .filter((v) => v !== undefined);
    assert.equal(temps.at(-1), 2350);
});

test('F14: fallback after a non-queryable registration unregisters the endpoint before re-registering', async (t) => {
    const storagePath = tmpStorage(t, 'klares4-race-');
    // Neither Thermostat payload answers (TH-01: the 2.2.0 one is tried second).
    const hb = makeHbMatterApi({ unqueryableTimes: { thermostat_18: 2 } });
    const registry = new MatterAccessoryRegistry({
        api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath,
    });

    await registry.addOrUpdateAccessory(thermostat());
    await delay(1500);

    assert.deepEqual(hb.log, [], 'Homebridge must not reject a duplicate registration');
    assert.deepEqual(hb.unregisterCalls, ['thermostat_18', 'thermostat_18']);
    assert.equal(hb.endpoints.get('thermostat_18').deviceType.name, 'TemperatureSensor');
    assert.equal(registry.getStatus('thermostat_18'), 'registered');
});

test('F14: registration retry unregisters the stale endpoint on the first attempt', async (t) => {
    const storagePath = tmpStorage(t, 'klares4-race-');
    const hb = makeHbMatterApi({ unqueryableOnce: ['light_9'] });
    const registry = new MatterAccessoryRegistry({
        api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath,
    });

    await registry.addOrUpdateAccessory({
        id: 'light_9', type: 'light', name: 'Taverna', description: '', status: { on: true, dimmable: false },
    });
    await delay(1500);

    assert.deepEqual(hb.log, []);
    assert.deepEqual(hb.unregisterCalls, ['light_9']);
    assert.equal(registry.getStatus('light_9'), 'registered');
});

// F37. Homebridge closes the endpoint first (reads already answer nothing)
// and deletes the UUID from its registry only afterwards. On 2.4 the
// unregister call resolves before that, so only the coordinator's settle (and
// the second probe after it) keeps the register that follows from racing the
// close; on 2.5 the call resolves after it. Without the settle the 2.4 case
// fails with "already registered" (last test).
function f37Light(uuid, name) {
    return {
        UUID: uuid, displayName: name, serialNumber: uuid, manufacturer: 'Ksenia', model: 'Lares4 light',
        deviceType: deviceTypes.OnOffLight, clusters: { onOff: { onOff: false } },
    };
}

for (const semantics of ['2.4', '2.5']) {
    test(`F37: a re-register waits until Homebridge has really released the UUID (${semantics})`, async () => {
        const { MatterTopologyCoordinator } = require('../dist/platform/matter-topology-coordinator.js');
        const hb = makeHbMatterApi({ semantics, unregisterCloseMs: 80 });
        const coordinator = new MatterTopologyCoordinator(hb.api, silentLog(), 2000, 150);

        await coordinator.register(f37Light('light_37', 'PC'));
        await waitFor(() => hb.endpoints.has('light_37'));
        assert.equal(await coordinator.unregister('light_37', 'onOff'), true);
        await coordinator.register(f37Light('light_37', 'PC Test'));
        await waitFor(() => hb.endpoints.get('light_37')?.displayName === 'PC Test' || hb.log.length > 0);

        assert.deepEqual(hb.log, [], 'register raced the endpoint close');
        assert.equal(hb.endpoints.get('light_37')?.closing, undefined);
    });
}

test('F37: the 2.4 race is real: without the settle the re-register is refused', async () => {
    const { MatterTopologyCoordinator } = require('../dist/platform/matter-topology-coordinator.js');
    const hb = makeHbMatterApi({ semantics: '2.4', unregisterCloseMs: 80 });
    const coordinator = new MatterTopologyCoordinator(hb.api, silentLog(), 2000, 0);

    await coordinator.register(f37Light('light_38', 'A'));
    await waitFor(() => hb.endpoints.has('light_38'));
    await coordinator.unregister('light_38', 'onOff');
    await coordinator.register(f37Light('light_38', 'B'));
    await waitFor(() => hb.log.length > 0);
    assert.match(hb.log[0], /already registered/);
});
