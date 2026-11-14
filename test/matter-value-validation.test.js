'use strict';

// MAT-13: values that are out of range or not finite (a Homebridge cache
// written by an older version, merged into the discovery snapshot) must
// neither make the registration fail nor reach the controllers as readings.

const test = require('node:test');
const assert = require('node:assert/strict');

const { deviceToMatterAccessory, mapThermostatAsTemperatureSensor } = require('../dist/platform/matter-device-mapper.js');
const { buildStateUpdates } = require('../dist/platform/matter-state-updates.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');

const PLUGIN = 'homebridge-plugin-klares4';
const PLATFORM = 'Lares4Complete';
const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });
const deps = (stack) => ({ api: stack.api, log: silentLog(), getWsClient: () => undefined });

const cover = (n, position, targetPosition) => ({
    id: `cover_${n}`, type: 'cover', name: `Tenda ${n}`, description: '', status: { position, targetPosition, state: 'stopped' },
});
const dimmer = (n, brightness) => ({
    id: `light_${n}`, type: 'light', name: `Faretto ${n}`, description: '', status: { on: true, dimmable: true, brightness },
});
const sensor = (n, sensorType, value) => ({
    id: `sensor_${sensorType}_${n}`, type: 'sensor', name: `Sonda ${sensorType} ${n}`, description: '', status: { sensorType, value },
});

async function registerOn(stack, accessory) {
    await stack.api.matter.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
    const failures = stack.hbLines.filter((l) => /Failed to register/.test(l));
    assert.ok(stack.record(accessory.UUID), `${accessory.UUID} must register; Homebridge said: ${failures.join(' | ')}`);
}

test('MAT-13: covers with a position out of range or not a number register', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const cases = [[1, 150, 150, 0], [2, -5, -5, 10000], [3, NaN, undefined, null], [4, 40, Infinity, 6000]];
    for (const [n, position, target, expectedCurrent] of cases) {
        await registerOn(stack, deviceToMatterAccessory(cover(n, position, target), deps(stack)));
        assert.equal(stack.read(`cover_${n}`, 'windowCovering').currentPositionLiftPercent100ths, expectedCurrent, `cover_${n}`);
    }
});

test('MAT-13: dimmers with a brightness out of range or not a number register with a valid level', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    for (const [n, brightness, level] of [[1, 150, 254], [2, NaN, 254], [3, -20, 1], [4, '40', 254]]) {
        await registerOn(stack, deviceToMatterAccessory(dimmer(n, brightness), deps(stack)));
        assert.equal(stack.read(`light_${n}`, 'levelControl').currentLevel, level, `light_${n}`);
    }
});

test('MAT-13: a measure that is not a finite number registers as unknown (null), never as 0 or NaN', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const cases = [
        [sensor(1, 'humidity', NaN), 'relativeHumidityMeasurement'],
        [sensor(2, 'humidity', undefined), 'relativeHumidityMeasurement'],
        [sensor(3, 'temperature', undefined), 'temperatureMeasurement'],
        [sensor(4, 'temperature', Infinity), 'temperatureMeasurement'],
        [sensor(5, 'light', NaN), 'illuminanceMeasurement'],
    ];
    for (const [device, cluster] of cases) {
        // Observed snapshots (not discovery placeholders) carrying an invalid value.
        await registerOn(stack, deviceToMatterAccessory(device, deps(stack)));
        assert.equal(stack.read(device.id, cluster).measuredValue, null, device.id);
    }
    const thermostat = { id: 'thermostat_9', type: 'thermostat', name: 'Termostato prova', description: '', currentTemperature: undefined, status: {} };
    await registerOn(stack, mapThermostatAsTemperatureSensor(thermostat, deps(stack)));
    assert.equal(stack.read('thermostat_9', 'temperatureMeasurement').measuredValue, null, 'no 21 °C placeholder');
});

test('MAT-13: state updates leave invalid values out, so the last valid one stays', () => {
    assert.deepEqual(buildStateUpdates(sensor(1, 'humidity', NaN)), []);
    assert.deepEqual(buildStateUpdates(sensor(2, 'temperature', undefined)), []);
    assert.deepEqual(buildStateUpdates(dimmer(3, NaN)), [{ clusterName: 'onOff', attributes: { onOff: true } }]);
    assert.deepEqual(buildStateUpdates(cover(4, NaN, 80)), [
        { clusterName: 'windowCovering', attributes: { targetPositionLiftPercent100ths: 2000 } },
    ]);
    assert.deepEqual(buildStateUpdates(cover(5, 150, undefined)), [
        { clusterName: 'windowCovering', attributes: { currentPositionLiftPercent100ths: 0, targetPositionLiftPercent100ths: 0 } },
    ]);
    const thermostat = { id: 'thermostat_6', type: 'thermostat', name: 'T', description: '', currentTemperature: undefined, status: {} };
    assert.deepEqual(buildStateUpdates(thermostat, true), [], 'no 21 °C placeholder for the fallback sensor');
});
