const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '5';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '10';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { markStatusPlaceholder } = require('../dist/device-observation.js');
const { makeHb24MatterApi, deviceTypes } = require('./fixtures/hb24-matter-api.js');

const silentLog = () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storage = () => fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-placeholder-'));

// Discovery (READ_RES BUS_HAS) fills the value with a parser default.
function placeholderSensor(id, sensorType) {
    const device = { id, type: 'sensor', name: `Sensore ${sensorType}`, description: '', status: { sensorType, value: 0 } };
    markStatusPlaceholder(device);
    return device;
}

function registry(hb, storagePath = storage()) {
    return new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath });
}

test('a fresh measurement endpoint starts with a null measuredValue, not the discovery placeholder', async () => {
    const hb = makeHb24MatterApi();
    const reg = registry(hb);
    await reg.addOrUpdateAccessory(placeholderSensor('sensor_t', 'temperature'));
    await reg.addOrUpdateAccessory(placeholderSensor('sensor_h', 'humidity'));
    await reg.addOrUpdateAccessory(placeholderSensor('sensor_l', 'light'));
    await delay(60);

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

test('a thermostat TemperatureSensor fallback also starts with a null measuredValue', async () => {
    const storagePath = storage();
    fs.writeFileSync(path.join(storagePath, 'klares4-matter-fallback.json'), JSON.stringify({ thermostatAsTemperatureSensor: ['thermostat_5'] }));
    const hb = makeHb24MatterApi();
    const reg = registry(hb, storagePath);
    const device = {
        id: 'thermostat_5', type: 'thermostat', name: 'Riscaldamento Bagno', description: '',
        currentTemperature: 0, targetTemperature: 0, mode: 'off',
        status: { currentTemperature: 0, targetTemperature: 0, mode: 'off' },
    };
    markStatusPlaceholder(device);
    await reg.addOrUpdateAccessory(device);
    await delay(60);
    assert.equal(hb.endpoints.get('thermostat_5').deviceType.name, 'TemperatureSensor');
    assert.equal(hb.endpoints.get('thermostat_5').clusters.temperatureMeasurement.measuredValue, null);
});

test('state known from the Homebridge cache still seeds the endpoint', async () => {
    const hb = makeHb24MatterApi();
    const reg = registry(hb);
    reg.configureCachedAccessory({
        UUID: 'sensor_t',
        displayName: 'Sensore temperature',
        deviceType: deviceTypes.TemperatureSensor,
        context: { device: { id: 'sensor_t', type: 'sensor', name: 'Sensore temperature', description: '', status: { sensorType: 'temperature', value: 19 } } },
    });
    await reg.addOrUpdateAccessory(placeholderSensor('sensor_t', 'temperature'));
    await delay(60);
    assert.equal(hb.endpoints.get('sensor_t').clusters.temperatureMeasurement.measuredValue, 1900);
});

test('a thermostat that falls back during recovery does not publish its placeholder temperature', async () => {
    process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '10';
    const hb = makeHb24MatterApi({ unqueryableOnce: ['thermostat_6'] });
    const reg = registry(hb);
    const device = {
        id: 'thermostat_6', type: 'thermostat', name: 'Riscaldamento Studio', description: '',
        currentTemperature: 0, targetTemperature: 0, mode: 'off',
        status: { currentTemperature: 0, targetTemperature: 0, mode: 'off' },
    };
    markStatusPlaceholder(device);
    await reg.addOrUpdateAccessory(device);
    await delay(800);
    assert.equal(hb.endpoints.get('thermostat_6').deviceType.name, 'TemperatureSensor');
    assert.equal(reg.getStatus('thermostat_6'), 'registered');
    assert.equal(hb.endpoints.get('thermostat_6').clusters.temperatureMeasurement.measuredValue, null);
    assert.deepEqual(hb.updates.filter((u) => u.uuid === 'thermostat_6'), []);
});
