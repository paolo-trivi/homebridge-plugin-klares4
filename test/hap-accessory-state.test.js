const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');

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
