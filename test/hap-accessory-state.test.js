const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');

const { CoverAccessory } = require('../dist/accessories/cover-accessory.js');
const { GateAccessory } = require('../dist/accessories/gate-accessory.js');
const { ThermostatAccessory } = require('../dist/accessories/thermostat-accessory.js');
const { ZoneAccessory } = require('../dist/accessories/zone-accessory.js');

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

function thermostatDevice(status) {
    return {
        id: 'thermostat_18', type: 'thermostat', name: 'Sala', description: '',
        currentTemperature: status.currentTemperature,
        targetTemperature: status.targetTemperature,
        mode: status.mode,
        status: { ...status },
    };
}

test('thermostat: a status update follows the real HVAC output, not the temperature gap', () => {
    const device = thermostatDevice({ currentTemperature: 20, targetTemperature: 21, mode: 'heat', hvacOutputActive: true });
    const accessory = platformAccessory(device);
    const handler = new ThermostatAccessory(platform(undefined), accessory);
    const current = accessory.getService(Service.Thermostat).getCharacteristic(Characteristic.CurrentHeatingCoolingState);
    assert.equal(current.value, Characteristic.CurrentHeatingCoolingState.HEAT);

    // Below setpoint, but the panel reports the heating output as idle.
    handler.updateStatus(thermostatDevice({ currentTemperature: 18, targetTemperature: 21, mode: 'heat', hvacOutputActive: false }));
    assert.equal(current.value, Characteristic.CurrentHeatingCoolingState.OFF);

    // Above setpoint, but the output is still running (e.g. post-circulation).
    handler.updateStatus(thermostatDevice({ currentTemperature: 22, targetTemperature: 21, mode: 'heat', hvacOutputActive: true }));
    assert.equal(current.value, Characteristic.CurrentHeatingCoolingState.HEAT);
});

test('cover and gate: building the handler never runs their own write handlers', (t) => {
    const setTarget = t.mock.method(CoverAccessory.prototype, 'setTargetPosition');
    const setGate = t.mock.method(GateAccessory.prototype, 'setOn');
    const calls = [];
    const wsClient = {
        moveCover: async (...args) => { calls.push(['moveCover', ...args]); },
        toggleGate: async (...args) => { calls.push(['toggleGate', ...args]); },
    };

    const cover = { id: 'cover_3', type: 'cover', name: 'Tapparella', description: '', status: { position: 40, state: 'stopped' } };
    const coverAccessory = platformAccessory(cover);
    new CoverAccessory(platform(wsClient), coverAccessory);
    const gate = { id: 'gate_5', type: 'gate', name: 'Cancello', description: '', status: { on: false } };
    const gateAccessory = platformAccessory(gate);
    new GateAccessory(platform(wsClient), gateAccessory);

    assert.equal(setTarget.mock.callCount(), 0);
    assert.equal(setGate.mock.callCount(), 0);
    assert.deepEqual(calls, []);
    const covering = coverAccessory.getService(Service.WindowCovering);
    assert.equal(covering.getCharacteristic(Characteristic.CurrentPosition).value, 40);
    assert.equal(covering.getCharacteristic(Characteristic.TargetPosition).value, 40);
    assert.equal(covering.getCharacteristic(Characteristic.PositionState).value, Characteristic.PositionState.STOPPED);
    assert.equal(gateAccessory.getService(Service.Switch).getCharacteristic(Characteristic.On).value, false);
});

function coverDevice(status) {
    return { id: 'cover_7', type: 'cover', name: 'Tapparella', description: '', status: { ...status } };
}

test('cover: a command sent outside HomeKit (MQTT) publishes the new TargetPosition', async () => {
    const wsClient = { moveCover: async () => undefined };
    const accessory = platformAccessory(coverDevice({ position: 20, state: 'stopped' }));
    const handler = new CoverAccessory(platform(wsClient), accessory);
    try {
        await handler.setTargetPosition(80); // what the MQTT command executor calls
        const covering = accessory.getService(Service.WindowCovering);
        assert.equal(covering.getCharacteristic(Characteristic.TargetPosition).value, 80);
        assert.equal(covering.getCharacteristic(Characteristic.PositionState).value, Characteristic.PositionState.INCREASING);
    } finally {
        handler.dispose();
    }
});

test('cover: the panel target (TPOS) is published even when the position has not moved yet', () => {
    const accessory = platformAccessory(coverDevice({ position: 20, state: 'stopped' }));
    const handler = new CoverAccessory(platform(undefined), accessory);
    const covering = accessory.getService(Service.WindowCovering);

    // Movement started from the keypad: POS still 20, TPOS already 80.
    handler.updateStatus(coverDevice({ position: 20, targetPosition: 80, state: 'opening' }));
    assert.equal(covering.getCharacteristic(Characteristic.CurrentPosition).value, 20);
    assert.equal(covering.getCharacteristic(Characteristic.TargetPosition).value, 80);
    assert.equal(covering.getCharacteristic(Characteristic.PositionState).value, Characteristic.PositionState.INCREASING);

    // Stopped half way: target follows the panel back to the real position.
    handler.updateStatus(coverDevice({ position: 50, targetPosition: 50, state: 'stopped' }));
    assert.equal(covering.getCharacteristic(Characteristic.CurrentPosition).value, 50);
    assert.equal(covering.getCharacteristic(Characteristic.TargetPosition).value, 50);
    assert.equal(covering.getCharacteristic(Characteristic.PositionState).value, Characteristic.PositionState.STOPPED);
});

test('cover: without a panel target the TargetPosition falls back to the position', () => {
    const accessory = platformAccessory(coverDevice({ position: 30, state: 'stopped' }));
    const handler = new CoverAccessory(platform(undefined), accessory);
    const covering = accessory.getService(Service.WindowCovering);
    covering.updateCharacteristic(Characteristic.TargetPosition, 90); // stale value left by a controller

    handler.updateStatus(coverDevice({ position: 30, state: 'stopped' }));
    assert.equal(covering.getCharacteristic(Characteristic.TargetPosition).value, 30);
});

test('cover: choosing the current position during a movement stops the cover there', async () => {
    const moves = [];
    const wsClient = { moveCover: async (id, position) => { moves.push(position); } };
    const accessory = platformAccessory(coverDevice({ position: 20, state: 'stopped' }));
    const handler = new CoverAccessory(platform(wsClient), accessory);
    const covering = accessory.getService(Service.WindowCovering);
    try {
        await handler.setTargetPosition(80); // simulation now running from 20
        await handler.setTargetPosition(20); // user changes their mind: stay here

        assert.deepEqual(moves, [80, 20]);
        assert.equal(await handler.getTargetPosition(), 20);
        assert.equal(covering.getCharacteristic(Characteristic.TargetPosition).value, 20);
        assert.equal(await handler.getPositionState(), Characteristic.PositionState.STOPPED);
    } finally {
        handler.dispose();
    }
});

test('cover: choosing the current position at rest sends nothing and keeps the target aligned', async () => {
    const moves = [];
    const wsClient = { moveCover: async (id, position) => { moves.push(position); } };
    const accessory = platformAccessory(coverDevice({ position: 20, state: 'stopped' }));
    const handler = new CoverAccessory(platform(wsClient), accessory);
    const covering = accessory.getService(Service.WindowCovering);
    covering.updateCharacteristic(Characteristic.TargetPosition, 70); // stale controller value

    await handler.setTargetPosition(20);

    assert.deepEqual(moves, []);
    assert.equal(await handler.getTargetPosition(), 20);
    assert.equal(covering.getCharacteristic(Characteristic.TargetPosition).value, 20);
    assert.equal(await handler.getPositionState(), Characteristic.PositionState.STOPPED);
});

test('thermostat: the chosen temperature display unit is kept and survives a restart', async () => {
    const device = thermostatDevice({ currentTemperature: 20, targetTemperature: 21, mode: 'heat' });
    const accessory = platformAccessory(device);
    const handler = new ThermostatAccessory(platform(undefined), accessory);
    const units = () => accessory.getService(Service.Thermostat).getCharacteristic(Characteristic.TemperatureDisplayUnits);
    assert.equal(await handler.getTemperatureDisplayUnits(), Characteristic.TemperatureDisplayUnits.CELSIUS);

    await units().handleSetRequest(Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
    assert.equal(await units().handleGetRequest(), Characteristic.TemperatureDisplayUnits.FAHRENHEIT);

    // Restart: a new handler on the cached accessory (context persisted by Homebridge).
    const restarted = new ThermostatAccessory(platform(undefined), accessory);
    assert.equal(await restarted.getTemperatureDisplayUnits(), Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
    assert.equal(units().value, Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
});

test('zone: a bypassed zone is inactive, not tampered', async () => {
    const zone = (status) => ({ id: 'zone_4', type: 'zone', name: 'Finestra Cucina', description: '', status: { armed: false, fault: false, open: false, ...status } });
    const accessory = platformAccessory(zone({ bypassed: true }));
    const handler = new ZoneAccessory(platform(undefined), accessory);
    const sensor = accessory.getService(Service.ContactSensor);
    const tampered = () => sensor.getCharacteristic(Characteristic.StatusTampered).value;
    const active = () => sensor.getCharacteristic(Characteristic.StatusActive).value;

    assert.equal(tampered(), Characteristic.StatusTampered.NOT_TAMPERED);
    assert.equal(await handler.getStatusTampered(), Characteristic.StatusTampered.NOT_TAMPERED);
    assert.equal(active(), false);

    handler.updateStatus(zone({ bypassed: false }));
    assert.equal(tampered(), Characteristic.StatusTampered.NOT_TAMPERED);
    assert.equal(active(), true);

    handler.updateStatus(zone({ bypassed: true }));
    assert.equal(tampered(), Characteristic.StatusTampered.NOT_TAMPERED);
    assert.equal(await handler.getStatusTampered(), Characteristic.StatusTampered.NOT_TAMPERED);
    assert.equal(active(), false);
});
