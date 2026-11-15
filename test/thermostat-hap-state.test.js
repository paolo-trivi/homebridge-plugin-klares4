'use strict';

// TH-07, TH-10 (HAP side), TH-13, SP-16: the HomeKit thermostat accessory.
const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');

const { ThermostatAccessory } = require('../dist/accessories/thermostat-accessory.js');
const { deriveHomeKitCurrentState } = require('../dist/thermostat-mode.js');
const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');
const { ThermostatStatusUpdater } = require('../dist/websocket-client/thermostat-status-updater.js');

const { Characteristic, Service } = hap;

function platformAccessory(device) {
    const accessory = new hap.Accessory(device.name, hap.uuid.generate(device.id));
    return {
        UUID: accessory.UUID, displayName: device.name, context: { device },
        getService: (type) => accessory.getService(type), addService: (type) => accessory.addService(type),
    };
}

function platform(wsClient, config = {}) {
    const warns = [];
    return {
        Service, Characteristic, api: { hap }, config, wsClient, warns,
        log: { info() {}, warn: (...a) => warns.push(a.join(' ')), error() {}, debug() {} },
    };
}

function device(over = {}) {
    const status = { currentTemperature: 20, targetTemperature: 21, mode: 'heat', ...over };
    return { id: 'thermostat_18', type: 'thermostat', name: 'Thermostat', description: '', ...status, status };
}

const realtime = (val, model = 'MAN', temp = '20.0') => [{
    ID: '1', TEMP: temp,
    THERM: { ACT_SEA: 'WIN', ACT_MODEL: model, TEMP_THR: model === 'OFF' ? { T: 'NA', VAL: 'NA' } : { T: 'M', VAL: val }, OUT_STATUS: 'OFF' },
}];

test('TH-07: a HomeKit change confirmed by the realtime reaches MQTT and Matter (status event)', async () => {
    const state = createInitialWebSocketClientState();
    const shared = device({ targetTemperature: 21 });
    state.devices.set(shared.id, shared);
    state.thermostatToDomus.set('18', '1');
    const emits = [];
    const updater = new ThermostatStatusUpdater({ state, emitDeviceStatusUpdate: (d) => emits.push({ target: d.status.targetTemperature, mode: d.status.mode }) });
    updater.updateTemperatureStatuses(realtime('21.0'));
    emits.length = 0;

    const handler = new ThermostatAccessory(platform({ setThermostatTemperature: async () => undefined, setThermostatMode: async () => undefined }), platformAccessory(shared));
    await handler.setTargetTemperature(23.5);
    updater.updateTemperatureStatuses(realtime('23.5'));
    assert.deepEqual(emits, [{ target: 23.5, mode: 'heat' }]);

    await handler.setTargetHeatingCoolingState(0);
    updater.updateTemperatureStatuses(realtime('NA', 'OFF'));
    assert.deepEqual(emits.at(-1), { target: 23.5, mode: 'off' });
    assert.equal(emits.length, 2);
});

test('TH-10: CurrentHeatingCoolingState in AUTO follows the output and the season', () => {
    assert.equal(deriveHomeKitCurrentState('auto', 21.0, 20.5, true, 'WIN'), 1, 'winter, output on, above target (hysteresis): heating');
    assert.equal(deriveHomeKitCurrentState('auto', 20.5, 20.5, true, 'WIN'), 1);
    assert.equal(deriveHomeKitCurrentState('auto', 22.0, 18.0, undefined, 'WIN'), 0, 'winter, output unknown, above target: idle, never cooling');
    assert.equal(deriveHomeKitCurrentState('auto', 27.0, 25.0, true, 'SUM'), 2);
    assert.equal(deriveHomeKitCurrentState('auto', 21.0, 20.5, false, 'WIN'), 0);
});

test('TH-10: the HAP accessory uses the realtime season in AUTO', () => {
    const accessory = platformAccessory(device({ mode: 'auto', currentTemperature: 21, targetTemperature: 20.5, hvacOutputActive: true, season: 'WIN' }));
    new ThermostatAccessory(platform(undefined), accessory);
    const value = accessory.getService(Service.Thermostat).getCharacteristic(Characteristic.CurrentHeatingCoolingState).value;
    assert.equal(value, Characteristic.CurrentHeatingCoolingState.HEAT);
});

test('TH-13: panel setpoints outside the HomeKit limits are shown at the nearest limit, without warnings', async () => {
    const origWarn = console.warn;
    const origLog = console.log;
    const origError = console.error;
    const printed = [];
    console.warn = console.log = console.error = (...a) => printed.push(a.join(' '));
    try {
        for (const [target, shown] of [[5, 10], [39.5, 38], [20.5, 20.5]]) {
            const accessory = platformAccessory(device());
            const handler = new ThermostatAccessory(platform(undefined), accessory);
            handler.updateStatus(device({ targetTemperature: target }));
            const characteristic = accessory.getService(Service.Thermostat).getCharacteristic(Characteristic.TargetTemperature);
            assert.equal(characteristic.value, shown);
            assert.equal(await handler.getTargetTemperature(), shown);
        }
        // Configured limits narrower than HomeKit's defaults: no warning when they are applied.
        new ThermostatAccessory(platform(undefined, { temperatureDefaults: { min: 16, max: 26 } }), platformAccessory(device()));
    } finally {
        console.warn = origWarn;
        console.log = origLog;
        console.error = origError;
    }
    assert.deepEqual(printed.filter((line) => /illegal|exceed/i.test(line)), []);
});

test('SP-16: a setpoint outside temperatureDefaults.min/max (e.g. from MQTT) is refused, nothing sent', async () => {
    const sent = [];
    const p = platform({ setThermostatTemperature: async (id, value) => sent.push(value) }, { temperatureDefaults: { min: 16, max: 26 } });
    const handler = new ThermostatAccessory(p, platformAccessory(device()));
    for (const value of [5, 40, Number.NaN]) {
        await assert.rejects(() => handler.setTargetTemperature(value), (error) => error instanceof hap.HapStatusError);
    }
    await handler.setTargetTemperature(16);
    await handler.setTargetTemperature(26);
    assert.deepEqual(sent, [16, 26]);
    assert.equal(p.warns.length, 3);
});

test('rc.1 D3: a HomeKit setpoint in AUTO is stored, and HomeKit goes back to the target the panel uses', async () => {
    const sent = [];
    const accessory = platformAccessory(device({ mode: 'auto', targetTemperature: 19 }));
    new ThermostatAccessory(platform({ setThermostatTemperature: async (id, value) => sent.push(value) }), accessory);
    const target = accessory.getService(Service.Thermostat).getCharacteristic(Characteristic.TargetTemperature);
    await target.handleSetRequest(25);
    assert.equal(target.value, 25, 'hap-nodejs stores the written value first');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [25]);
    assert.equal(target.value, 19);
});

test('rc.1 D3: in MAN the written setpoint stays (it is the live one)', async () => {
    const accessory = platformAccessory(device({ mode: 'heat', targetTemperature: 19 }));
    new ThermostatAccessory(platform({ setThermostatTemperature: async () => undefined }), accessory);
    const target = accessory.getService(Service.Thermostat).getCharacteristic(Characteristic.TargetTemperature);
    await target.handleSetRequest(23);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(target.value, 23);
});
