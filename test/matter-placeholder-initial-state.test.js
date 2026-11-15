const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '5';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '10';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { markStatusPlaceholder } = require('../dist/device-observation.js');
const { makeHbMatterApi, deviceTypes } = require('./fixtures/hb-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const silentLog = () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storage = (t) => tmpStorage(t, 'klares4-placeholder-');

// Discovery (READ_RES BUS_HAS) fills the value with a parser default.
function placeholderSensor(id, sensorType) {
    const device = { id, type: 'sensor', name: `Sensore ${sensorType}`, description: '', status: { sensorType, value: 0 } };
    markStatusPlaceholder(device);
    return device;
}

function registry(t, hb, storagePath = storage(t)) {
    return new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath });
}

test('a fresh measurement endpoint starts with a null measuredValue, not the discovery placeholder', async (t) => {
    const hb = makeHbMatterApi();
    const reg = registry(t, hb);
    await reg.addOrUpdateAccessory(placeholderSensor('sensor_t', 'temperature'));
    await reg.addOrUpdateAccessory(placeholderSensor('sensor_h', 'humidity'));
    await reg.addOrUpdateAccessory(placeholderSensor('sensor_l', 'light'));
    await waitFor(() => ['sensor_t', 'sensor_h', 'sensor_l'].every((id) => reg.getStatus(id) === 'registered'));

    assert.equal(hb.endpoints.get('sensor_t').clusters.temperatureMeasurement.measuredValue, null);
    assert.equal(hb.endpoints.get('sensor_h').clusters.relativeHumidityMeasurement.measuredValue, null);
    assert.equal(hb.endpoints.get('sensor_l').clusters.illuminanceMeasurement.measuredValue, null);
    for (const id of ['sensor_t', 'sensor_h', 'sensor_l']) assert.equal(reg.getStatus(id), 'registered');

    // The first real reading fills it.
    await reg.updateAccessoryState({ id: 'sensor_t', type: 'sensor', name: 'Sensore temperature', description: '', status: { sensorType: 'temperature', value: 21.5 } });
    await delay(20);
    const pushed = hb.updates.filter((u) => u.uuid === 'sensor_t' && u.cluster === 'temperatureMeasurement');
    assert.deepEqual(pushed.map((u) => u.attributes.measuredValue), [2150]);
});

test('a thermostat TemperatureSensor fallback also starts with a null measuredValue', async (t) => {
    const storagePath = storage(t);
    // A fallback decided with the current Thermostat payload (a legacy one gets one native attempt, TH-01).
    fs.writeFileSync(path.join(storagePath, 'klares4-matter-fallback.json'), JSON.stringify({
        version: 2,
        thermostats: [{ deviceId: 'thermostat_5', mode: 'fallback', reason: 'registration-failure', attempts: 0, nativeShapeRevision: 2, pluginVersion: '2.3.0' }],
    }));
    const hb = makeHbMatterApi();
    const reg = registry(t, hb, storagePath);
    const device = {
        id: 'thermostat_5', type: 'thermostat', name: 'Riscaldamento Atrio', description: '',
        currentTemperature: 0, targetTemperature: 0, mode: 'off',
        status: { currentTemperature: 0, targetTemperature: 0, mode: 'off' },
    };
    markStatusPlaceholder(device);
    await reg.addOrUpdateAccessory(device);
    await waitFor(() => reg.getStatus('thermostat_5') === 'registered');
    assert.equal(hb.endpoints.get('thermostat_5').deviceType.name, 'TemperatureSensor');
    assert.equal(hb.endpoints.get('thermostat_5').clusters.temperatureMeasurement.measuredValue, null);
});

test('state the panel reported and the cache recorded still seeds the endpoint', async (t) => {
    const hb = makeHbMatterApi();
    const reg = registry(t, hb);
    reg.configureCachedAccessory({
        UUID: 'sensor_t',
        displayName: 'Sensore temperature',
        deviceType: deviceTypes.TemperatureSensor,
        context: { panelReported: 1, device: { id: 'sensor_t', type: 'sensor', name: 'Sensore temperature', description: '', status: { sensorType: 'temperature', value: 19 } } },
    });
    await reg.addOrUpdateAccessory(placeholderSensor('sensor_t', 'temperature'));
    await waitFor(() => reg.getStatus('sensor_t') === 'registered');
    assert.equal(hb.endpoints.get('sensor_t').clusters.temperatureMeasurement.measuredValue, 1900);
});

test('PLAT-R1: a cache without the marker (2.2.0) holds a placeholder, not a reading', async (t) => {
    const hb = makeHbMatterApi();
    const reg = registry(t, hb);
    reg.configureCachedAccessory({
        UUID: 'sensor_t',
        displayName: 'Sensore temperature',
        deviceType: deviceTypes.TemperatureSensor,
        context: { device: { id: 'sensor_t', type: 'sensor', name: 'Sensore temperature', description: '', status: { sensorType: 'temperature', value: 0 } } },
    });
    await reg.addOrUpdateAccessory(placeholderSensor('sensor_t', 'temperature'));
    await waitFor(() => reg.getStatus('sensor_t') === 'registered');
    assert.equal(hb.endpoints.get('sensor_t').clusters.temperatureMeasurement.measuredValue, null);
});

test('a thermostat that falls back during recovery does not publish its placeholder temperature', async (t) => {
    process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '10';
    const hb = makeHbMatterApi({ unqueryableTimes: { thermostat_6: 2 } }); // both Thermostat payloads (TH-01)
    const reg = registry(t, hb);
    const device = {
        id: 'thermostat_6', type: 'thermostat', name: 'Riscaldamento Solaio', description: '',
        currentTemperature: 0, targetTemperature: 0, mode: 'off',
        status: { currentTemperature: 0, targetTemperature: 0, mode: 'off' },
    };
    markStatusPlaceholder(device);
    await reg.addOrUpdateAccessory(device);
    await waitFor(() => reg.getStatus('thermostat_6') === 'registered'
        && hb.endpoints.get('thermostat_6')?.deviceType.name === 'TemperatureSensor');
    assert.equal(hb.endpoints.get('thermostat_6').deviceType.name, 'TemperatureSensor');
    assert.equal(reg.getStatus('thermostat_6'), 'registered');
    assert.equal(hb.endpoints.get('thermostat_6').clusters.temperatureMeasurement.measuredValue, null);
    assert.deepEqual(hb.updates.filter((u) => u.uuid === 'thermostat_6'), []);
});
