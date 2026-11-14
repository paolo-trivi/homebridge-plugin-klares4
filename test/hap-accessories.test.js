const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');

const { CoverAccessory } = require('../dist/accessories/cover-accessory.js');
const { LightAccessory } = require('../dist/accessories/light-accessory.js');
const { ThermostatAccessory } = require('../dist/accessories/thermostat-accessory.js');

const { Characteristic, Service } = hap;

// Minimal PlatformAccessory stand-in backed by a real HAP-NodeJS Accessory,
// so services/characteristics behave exactly as they do under Homebridge.
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
    return {
        Service,
        Characteristic,
        api: { hap },
        log: { info() {}, warn() {}, error() {}, debug() {} },
        config,
        wsClient,
    };
}

test('cover: a failed move leaves HomeKit stopped at the real position, not "opening" forever', async () => {
    const device = { id: 'cover_7', type: 'cover', name: 'Tapparella', description: '', status: { position: 20, state: 'stopped' } };
    const wsClient = { moveCover: async () => { throw new Error('WebSocket not connected'); } };
    const accessory = platformAccessory(device);
    const handler = new CoverAccessory(platform(wsClient), accessory);
    const service = accessory.getService(Service.WindowCovering);

    await assert.rejects(handler.setTargetPosition(80), (error) => error instanceof hap.HapStatusError);

    assert.equal(service.getCharacteristic(Characteristic.PositionState).value, Characteristic.PositionState.STOPPED);
    assert.equal(await handler.getPositionState(), Characteristic.PositionState.STOPPED);
    assert.equal(await handler.getTargetPosition(), 20);
    assert.equal(service.getCharacteristic(Characteristic.TargetPosition).value, 20);
});

test('thermostat: a write without a WebSocket client is reported as a failure, not a success', async () => {
    const device = {
        id: 'thermostat_18', type: 'thermostat', name: 'Sala', description: '',
        currentTemperature: 20, targetTemperature: 21, mode: 'heat',
        status: { currentTemperature: 20, targetTemperature: 21, mode: 'heat' },
    };
    const accessory = platformAccessory(device);
    const handler = new ThermostatAccessory(platform(undefined), accessory);

    await assert.rejects(handler.setTargetTemperature(24), (error) => error instanceof hap.HapStatusError);
    await assert.rejects(handler.setTargetHeatingCoolingState(0), (error) => error instanceof hap.HapStatusError);
    assert.equal(device.status.targetTemperature, 21);
    assert.equal(device.status.mode, 'heat');
});

test('light: brightness becomes controllable when dimming is learned after discovery', async () => {
    const calls = [];
    const wsClient = {
        switchLight: async (id, on) => { calls.push(['switch', id, on]); },
        dimLight: async (id, level) => { calls.push(['dim', id, level]); },
    };
    // Discovery always parses lights as non-dimmable; POS arrives with the first status.
    const discovered = { id: 'light_5', type: 'light', name: 'Lampadario', description: '', status: { on: false, dimmable: false } };
    const accessory = platformAccessory(discovered);
    const handler = new LightAccessory(platform(wsClient), accessory);
    handler.updateStatus({ ...discovered, status: { on: true, brightness: 60, dimmable: true } });

    const brightness = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness);
    await brightness.handleSetRequest(30);

    assert.deepEqual(calls, [['dim', 'light_5', 30]]);
});

test('cover: a failed move during a running movement keeps the previous target and direction', async () => {
    const device = { id: 'cover_8', type: 'cover', name: 'Tapparella Sala', description: '', status: { position: 20, state: 'stopped' } };
    let fail = false;
    const wsClient = { moveCover: async () => { if (fail) throw new Error('Panel rejected command: FAIL'); } };
    const accessory = platformAccessory(device);
    const handler = new CoverAccessory(platform(wsClient), accessory);
    try {
        await handler.setTargetPosition(80); // accepted: simulation now moving up
        fail = true;
        await assert.rejects(handler.setTargetPosition(10), (error) => error instanceof hap.HapStatusError);

        assert.equal(await handler.getTargetPosition(), 80);
        assert.equal(await handler.getPositionState(), Characteristic.PositionState.INCREASING);
    } finally {
        handler.dispose();
    }
});
