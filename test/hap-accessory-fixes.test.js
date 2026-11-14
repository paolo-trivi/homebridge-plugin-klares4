const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');

const { SensorAccessory } = require('../dist/accessories/sensor-accessory.js');
const { LightAccessory } = require('../dist/accessories/light-accessory.js');
const { CoverAccessory } = require('../dist/accessories/cover-accessory.js');
const { GateAccessory } = require('../dist/accessories/gate-accessory.js');
const { ScenarioAccessory } = require('../dist/accessories/scenario-accessory.js');
const { AccessoryHandlerService } = require('../dist/platform/accessory-handler-service.js');
const { markStatusPlaceholder } = require('../dist/device-observation.js');

const { Characteristic, Service, HAPStatus } = hap;

function platformAccessory(device) {
    const accessory = new hap.Accessory(device.name, hap.uuid.generate(device.id));
    return {
        UUID: accessory.UUID,
        displayName: device.name,
        context: { device },
        getService: (type) => accessory.getService(type),
        addService: (type) => accessory.addService(type),
    };
}

function platform(wsClient, config = {}) {
    const log = { warns: [], info() {}, warn(...a) { this.warns.push(a.join(' ')); }, error() {}, debug() {} };
    return { Service, Characteristic, api: { hap }, log, config, wsClient };
}

const sensor = (sensorType, value, unit) => ({
    id: `sensor_${sensorType}_9`, type: 'sensor', name: 'Probe', description: '', status: { sensorType, value, unit },
});

const SENSORS = [
    ['temperature', Service.TemperatureSensor, Characteristic.CurrentTemperature, 0, 21.5, 21.5],
    ['humidity', Service.HumiditySensor, Characteristic.CurrentRelativeHumidity, 50, 44, 44],
    ['light', Service.LightSensor, Characteristic.CurrentAmbientLightLevel, 100, 250, 250],
    ['motion', Service.MotionSensor, Characteristic.MotionDetected, 0, 1, true],
    ['contact', Service.ContactSensor, Characteristic.ContactSensorState, 0, 1, 1],
];

for (const [kind, serviceType, characteristicType, placeholder, measured, expected] of SENSORS) {
    test(`PLAT-11: a ${kind} sensor never observed answers "no response", not its placeholder`, async () => {
        const device = sensor(kind, placeholder);
        markStatusPlaceholder(device);
        const accessory = platformAccessory(device);
        const handler = new SensorAccessory(platform(), accessory);
        const characteristic = accessory.getService(serviceType).getCharacteristic(characteristicType);

        await assert.rejects(characteristic.handleGetRequest(), (status) => status === HAPStatus.SERVICE_COMMUNICATION_FAILURE);

        // The real reading arrives: from then on the value is served.
        const observed = sensor(kind, measured);
        handler.updateStatus(observed);
        assert.equal(await characteristic.handleGetRequest(), expected);
    });
}

test('PLAT-11: an observed sensor serves the clamped reading; one that is not a number has none', async () => {
    const accessory = platformAccessory(sensor('temperature', 150));
    const handler = new SensorAccessory(platform(), accessory);
    const characteristic = accessory.getService(Service.TemperatureSensor).getCharacteristic(Characteristic.CurrentTemperature);
    assert.equal(await characteristic.handleGetRequest(), 100);

    handler.updateStatus(sensor('temperature', 18.5));
    assert.equal(await characteristic.handleGetRequest(), 18.5);

    for (const bad of [NaN, Infinity, null, undefined, '21']) {
        handler.device = sensor('temperature', bad);
        await assert.rejects(characteristic.handleGetRequest(), (status) => status === HAPStatus.SERVICE_COMMUNICATION_FAILURE, String(bad));
    }
});

test('PLAT-11: a placeholder update does not push a reading to HomeKit', () => {
    const accessory = platformAccessory(sensor('temperature', 18.5));
    const handler = new SensorAccessory(platform(), accessory);
    const characteristic = accessory.getService(Service.TemperatureSensor).getCharacteristic(Characteristic.CurrentTemperature);
    handler.updateStatus(sensor('temperature', 18.5));
    assert.equal(characteristic.value, 18.5);

    const placeholder = sensor('temperature', 0);
    markStatusPlaceholder(placeholder);
    handler.updateStatus(placeholder);
    assert.equal(characteristic.value, 18.5);
});

test('PLAT-12: brightness on a light that is not dimmable is an error and sends nothing', async () => {
    const calls = [];
    const wsClient = { dimLight: async (...a) => calls.push(a), switchLight: async (...a) => calls.push(a) };
    const p = platform(wsClient);
    const handler = new LightAccessory(p, platformAccessory({ id: 'light_3', type: 'light', name: 'Lamp', description: '', status: { on: false, dimmable: false } }));

    await assert.rejects(handler.setBrightness(40), (error) => error instanceof hap.HapStatusError
        && error.hapStatus === HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    assert.deepEqual(calls, []);
    assert.ok(p.log.warns.some((line) => /not dimmable/.test(line)));
});

test('PLAT-12: brightness on a dimmable light is still sent', async () => {
    const calls = [];
    const wsClient = { dimLight: async (...a) => calls.push(a) };
    const handler = new LightAccessory(platform(wsClient), platformAccessory({ id: 'light_4', type: 'light', name: 'Dimmer', description: '', status: { on: false, dimmable: true, brightness: 0 } }));
    await handler.setBrightness(40);
    assert.deepEqual(calls, [['light_4', 40]]);
});

function cover(status, placeholder = false) {
    const device = { id: 'cover_5', type: 'cover', name: 'Shutter', description: '', status: { ...status } };
    if (placeholder) markStatusPlaceholder(device);
    return device;
}

test('PLAT-12: a cover never observed still sends the command when the target equals its placeholder position', async () => {
    const moves = [];
    const wsClient = { moveCover: async (id, position) => { moves.push(position); } };
    const handler = new CoverAccessory(platform(wsClient, { maxSeconds: 30 }), platformAccessory(cover({ position: 0, state: 'stopped' }, true)));
    try {
        await handler.setTargetPosition(0);
        assert.deepEqual(moves, [0]);
    } finally {
        handler.dispose();
    }
});

test('PLAT-12: after the panel reports the position, choosing it again sends nothing (unchanged behaviour)', async () => {
    const moves = [];
    const wsClient = { moveCover: async (id, position) => { moves.push(position); } };
    const handler = new CoverAccessory(platform(wsClient), platformAccessory(cover({ position: 0, state: 'stopped' }, true)));
    handler.updateStatus(cover({ position: 20, state: 'stopped' }));
    await handler.setTargetPosition(20);
    assert.deepEqual(moves, []);
    handler.dispose();
});

test('PLAT-12: the end of a simulated movement is a belief, not a reading: the same target is sent again', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const moves = [];
    const wsClient = { moveCover: async (id, position) => { moves.push(position); } };
    const handler = new CoverAccessory(platform(wsClient, { maxSeconds: 10, coverStepSize: 50 }), platformAccessory(cover({ position: 0, state: 'stopped' })));
    try {
        await handler.setTargetPosition(100);
        t.mock.timers.tick(20_000); // the simulation ends at 100 without any panel update
        assert.equal(await handler.getCurrentPosition(), 100);
        await handler.setTargetPosition(100);
        assert.deepEqual(moves, [100, 100]);
    } finally {
        handler.dispose();
    }
});

test('PLAT-15: the gate auto-off follows scenarioAutoOffDelay', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wsClient = { toggleGate: async () => undefined };
    const accessory = platformAccessory({ id: 'gate_1', type: 'gate', name: 'Gate', description: '', status: { on: false } });
    const handler = new GateAccessory(platform(wsClient, { scenarioAutoOffDelay: 1500 }), accessory);
    const on = accessory.getService(Service.Switch).getCharacteristic(Characteristic.On);
    try {
        await handler.setOn(true);
        on.updateValue(true);
        t.mock.timers.tick(1000);
        assert.equal(on.value, true, 'still on after 1000 ms');
        t.mock.timers.tick(600);
        assert.equal(on.value, false, 'off after the configured delay');
    } finally {
        handler.dispose();
    }
});

test('PLAT-15: the gate falls back to 500 ms without a configured delay', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const accessory = platformAccessory({ id: 'gate_2', type: 'gate', name: 'Gate', description: '', status: { on: false } });
    const handler = new GateAccessory(platform({ toggleGate: async () => undefined }), accessory);
    const on = accessory.getService(Service.Switch).getCharacteristic(Characteristic.On);
    await handler.setOn(true);
    on.updateValue(true);
    t.mock.timers.tick(500);
    assert.equal(on.value, false);
    handler.dispose();
});

test('PLAT-15: a renamed scenario updates its handler and the cached context', () => {
    const device = { id: 'scenario_7', type: 'scenario', name: 'Old name', description: '', status: {} };
    const accessory = platformAccessory(device);
    const p = platform();
    const handler = new ScenarioAccessory(p, accessory, device);
    const service = new AccessoryHandlerService(p, p.log);

    const renamed = { ...device, name: 'New name' };
    service.updateAccessoryHandler(handler, renamed);

    assert.equal(handler.device.name, 'New name');
    assert.equal(accessory.context.device.name, 'New name');
});

test('PLAT-15: a scenario fires with the delay configured for scenarios', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const device = { id: 'scenario_8', type: 'scenario', name: 'Scene', description: '', status: {} };
    const accessory = platformAccessory(device);
    const handler = new ScenarioAccessory(platform({ triggerScenario: async () => undefined }, { scenarioAutoOffDelay: 900 }), accessory, device);
    const on = accessory.getService(Service.Switch).getCharacteristic(Characteristic.On);
    await handler.setOn(true);
    on.updateValue(true);
    t.mock.timers.tick(899);
    assert.equal(on.value, true);
    t.mock.timers.tick(1);
    assert.equal(on.value, false);
    handler.dispose();
});
