const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '5';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '10';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '10';
process.env.KLARES4_MATTER_REGISTER_RETRY_MS = '30';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { makeHbMatterApi } = require('./fixtures/hb-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const silentLog = () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storage = (t) => tmpStorage(t, 'klares4-retry-');

const zone = (open = false) => ({ id: 'zone_4', type: 'zone', name: 'Porta Ingresso', description: '', status: { armed: false, bypassed: false, fault: false, open } });

test('a registration refused while the Matter server is starting is retried on a later update', async (t) => {
    const hb = makeHbMatterApi({ serverStarting: true });
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath: storage(t) });
    await registry.addOrUpdateAccessory(zone());
    assert.equal(registry.getStatus('zone_4'), 'failed');

    hb.setServerStarting(false);
    // Within the retry interval nothing is attempted.
    await registry.updateAccessoryState(zone(true));
    assert.equal(hb.endpoints.has('zone_4'), false);

    await delay(40);
    await registry.updateAccessoryState(zone(true));
    await delay(60);
    assert.deepEqual(hb.log, []);
    await waitFor(() => registry.getStatus('zone_4') === 'registered');
    assert.equal(registry.getStatus('zone_4'), 'registered');
    assert.equal(hb.endpoints.get('zone_4').deviceType.name, 'ContactSensor');
});

test('a thermostat refused while the server is starting is not demoted to the TemperatureSensor fallback', async (t) => {
    const storagePath = storage(t);
    const hb = makeHbMatterApi({ serverStarting: true });
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    const thermostat = {
        id: 'thermostat_2', type: 'thermostat', name: 'Riscaldamento Cucina', description: '',
        currentTemperature: 20, targetTemperature: 21, mode: 'heat',
        status: { currentTemperature: 20, targetTemperature: 21, mode: 'heat' },
    };
    await registry.addOrUpdateAccessory(thermostat);
    assert.equal(registry.getStatus('thermostat_2'), 'failed');
    assert.deepEqual(hb.unregisterCalls, []);

    hb.setServerStarting(false);
    await delay(40);
    await registry.addOrUpdateAccessory(thermostat);
    await delay(60);
    assert.equal(hb.endpoints.get('thermostat_2').deviceType.name, 'Thermostat');
    assert.equal(fs.existsSync(path.join(storagePath, 'klares4-matter-fallback.json'))
        && fs.readFileSync(path.join(storagePath, 'klares4-matter-fallback.json'), 'utf8').includes('thermostat_2'), false);
});

test('any other register failure stays failed for the session', async (t) => {
    const hb = makeHbMatterApi();
    const register = hb.api.matter.registerPlatformAccessories;
    hb.api.matter.registerPlatformAccessories = async () => { throw new Error('Matter accessory is missing required serialNumber'); };
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath: storage(t) });
    await registry.addOrUpdateAccessory(zone());
    hb.api.matter.registerPlatformAccessories = register;
    await delay(40);
    await registry.updateAccessoryState(zone(true));
    await delay(60);
    assert.equal(registry.getStatus('zone_4'), 'failed');
    assert.equal(hb.registerCalls.length, 0);
});
