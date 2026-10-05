const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '5';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '10';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '10';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { makeHb24MatterApi, deviceTypes } = require('./fixtures/hb24-matter-api.js');

const silentLog = () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storage = () => fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-attach-name-'));

const light = (name) => ({ id: 'light_8', type: 'light', name, description: '', status: { on: false, dimmable: false } });

async function bootWithCache(cachedName, currentName) {
    const hb = makeHb24MatterApi({
        restored: [{ UUID: 'light_8', displayName: cachedName, deviceType: deviceTypes.OnOffLight, clusters: { onOff: {} } }],
    });
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath: storage() });
    registry.configureCachedAccessory({
        UUID: 'light_8', displayName: cachedName, deviceType: deviceTypes.OnOffLight,
        context: { device: light(cachedName) },
    });
    await registry.addOrUpdateAccessory(light(currentName));
    await delay(60);
    assert.equal(registry.getStatus('light_8'), 'registered');
    return { hb, registry };
}

test('a name changed while offline reaches the endpoint that was restored from cache', async () => {
    const { hb, registry } = await bootWithCache('Luce Vecchia', 'Luce Nuova');
    // Attaching in place keeps the restored endpoint and its old nodeLabel.
    assert.equal(hb.endpoints.get('light_8').nodeLabel, 'Luce Vecchia');

    await registry.finalizeNameMap([light('Luce Nuova')]);
    await delay(60);
    assert.deepEqual(hb.log, []);
    assert.deepEqual(hb.unregisterCalls, ['light_8']);
    assert.equal(hb.endpoints.get('light_8').nodeLabel, 'Luce Nuova');
    assert.equal(registry.getStatus('light_8'), 'registered');
});

test('an unchanged name restored from cache is never re-registered', async () => {
    const { hb, registry } = await bootWithCache('Luce Studio', 'Luce Studio');
    await registry.finalizeNameMap([light('Luce Studio')]);
    await delay(60);
    assert.deepEqual(hb.unregisterCalls, []);
    assert.equal(hb.registerCalls.length, 1);
});
