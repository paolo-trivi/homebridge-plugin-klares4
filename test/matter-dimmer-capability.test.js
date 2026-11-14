const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '50';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '10';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '20';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '20';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { makeHb24MatterApi, deviceTypes } = require('./fixtures/hb24-matter-api.js');

const silentLog = () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storage = () => fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-dimmer-'));

function light(status) {
    return { id: 'light_5', type: 'light', name: 'Faretti', description: '', status };
}

test('F04: a light discovered as on/off is re-registered as DimmableLight once the panel reports a level', async () => {
    const hb = makeHb24MatterApi();
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath: storage() });

    // READ_RES discovery always precedes STATUS_OUTPUTS, so dimmable is still unknown here.
    await registry.addOrUpdateAccessory(light({ on: false, dimmable: false }));
    await delay(150);
    assert.equal(hb.endpoints.get('light_5').deviceType.name, 'OnOffLight');

    await registry.updateAccessoryState(light({ on: true, dimmable: true, brightness: 60 }));
    await delay(600);

    assert.deepEqual(hb.log, []);
    assert.equal(hb.endpoints.get('light_5').deviceType.name, 'DimmableLight');
    assert.ok('levelControl' in hb.endpoints.get('light_5').clusters);
    assert.equal(registry.getStatus('light_5'), 'registered');
    const level = hb.updates.filter((u) => u.uuid === 'light_5' && u.cluster === 'levelControl').at(-1);
    assert.equal(level?.attributes.currentLevel, 152);
});

test('F04: a dimmer known from the Homebridge cache is registered as DimmableLight straight away', async () => {
    const hb = makeHb24MatterApi({
        restored: [{ UUID: 'light_5', deviceType: deviceTypes.DimmableLight, clusters: { onOff: {}, levelControl: {} } }],
    });
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath: storage() });
    registry.configureCachedAccessory({
        UUID: 'light_5',
        displayName: 'Faretti',
        deviceType: deviceTypes.DimmableLight,
        context: { device: light({ on: true, dimmable: true, brightness: 40 }) },
    });

    await registry.addOrUpdateAccessory(light({ on: false, dimmable: false }));
    await delay(200);

    assert.deepEqual(hb.log, []);
    assert.deepEqual(hb.unregisterCalls, []);
    assert.equal(hb.registerCalls[0].deviceType, 'DimmableLight');
    assert.equal(hb.endpoints.get('light_5').deviceType.name, 'DimmableLight');
});

test('F04: a plain on/off light is never re-registered', async () => {
    const hb = makeHb24MatterApi();
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath: storage() });
    await registry.addOrUpdateAccessory(light({ on: false, dimmable: false }));
    await delay(150);
    await registry.updateAccessoryState(light({ on: true, dimmable: false }));
    await delay(150);
    assert.equal(hb.registerCalls.length, 1);
    assert.deepEqual(hb.unregisterCalls, []);
});

test('F04: a level reported while the on/off registration is still pending upgrades once it completes', async () => {
    const hb = makeHb24MatterApi();
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath: storage() });

    await registry.addOrUpdateAccessory(light({ on: false, dimmable: false }));
    assert.equal(registry.getStatus('light_5'), 'pending');
    await registry.updateAccessoryState(light({ on: true, dimmable: true, brightness: 60 }));
    await delay(700);

    assert.deepEqual(hb.log, []);
    assert.equal(hb.endpoints.get('light_5').deviceType.name, 'DimmableLight');
    assert.equal(registry.getStatus('light_5'), 'registered');
    // No LevelControl write may ever target the OnOffLight endpoint.
    assert.deepEqual(hb.rejectedUpdates, []);
});

test('F04: a re-discovery that renames the light does not disable the dimmer upgrade', async () => {
    const hb = makeHb24MatterApi();
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath: storage() });

    await registry.addOrUpdateAccessory(light({ on: false, dimmable: false }));
    await delay(150);
    assert.equal(registry.getStatus('light_5'), 'registered');

    // Reconnect: READ_RES carries a new name, the status already knows the level.
    await registry.addOrUpdateAccessory({ ...light({ on: true, dimmable: true, brightness: 60 }), name: 'Faretti Cucina' });
    await delay(150);
    assert.deepEqual(hb.rejectedUpdates, [], 'no levelControl write to an OnOffLight endpoint');

    await registry.updateAccessoryState({ ...light({ on: true, dimmable: true, brightness: 60 }), name: 'Faretti Cucina' });
    await delay(600);
    assert.deepEqual(hb.log, []);
    assert.equal(hb.endpoints.get('light_5').deviceType.name, 'DimmableLight');
});
