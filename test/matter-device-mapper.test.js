const test = require('node:test');
const assert = require('node:assert/strict');

const { deviceToMatterAccessory } = require('../dist/platform/matter-device-mapper.js');

const fakeDeviceTypes = {
    OnOffLight: { _t: 'OnOffLight' },
    DimmableLight: { _t: 'DimmableLight' },
    WindowCovering: { _t: 'WindowCovering' },
    Thermostat: { _t: 'Thermostat' },
    TemperatureSensor: { _t: 'TemperatureSensor' },
    HumiditySensor: { _t: 'HumiditySensor' },
    LightSensor: { _t: 'LightSensor' },
    MotionSensor: { _t: 'MotionSensor' },
    ContactSensor: { _t: 'ContactSensor' },
    OnOffSwitch: { _t: 'OnOffSwitch' },
    OnOffOutlet: { _t: 'OnOffOutlet' },
};

function silentLog() {
    return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

function makeApi({ updateImpl } = {}) {
    const updates = [];
    return {
        api: {
            matter: {
                deviceTypes: fakeDeviceTypes,
                updateAccessoryState: async (uuid, clusterName, attributes, partId) => {
                    updates.push({ uuid, clusterName, attributes, partId });
                    if (updateImpl) return updateImpl({ uuid, clusterName, attributes, partId });
                },
            },
        },
        updates,
    };
}

function makeWsClient() {
    const calls = { triggerScenario: [], toggleGate: [] };
    return {
        client: {
            triggerScenario: async (id) => { calls.triggerScenario.push(id); },
            toggleGate: async (id) => { calls.toggleGate.push(id); },
        },
        calls,
    };
}

test('mapScenario exposes deviceType OnOffOutlet (not OnOffSwitch)', () => {
    const { api } = makeApi();
    const { client } = makeWsClient();
    const acc = deviceToMatterAccessory(
        { id: 'scenario_1', name: 'Mood Aperitivo', type: 'scenario' },
        { api, log: silentLog(), getWsClient: () => client },
    );
    assert.ok(acc, 'mapper must return an accessory');
    assert.equal(acc.deviceType, fakeDeviceTypes.OnOffOutlet, 'scenarios must be OnOffOutlet for Alexa compatibility');
    assert.notEqual(acc.deviceType, fakeDeviceTypes.OnOffSwitch, 'OnOffSwitch is a Matter client device and breaks Alexa');
    assert.deepEqual(acc.clusters.onOff, { onOff: false });
});

test('mapGate also uses OnOffOutlet (shares the momentary switch helper)', () => {
    const { api } = makeApi();
    const { client } = makeWsClient();
    const acc = deviceToMatterAccessory(
        { id: 'gate_1', name: 'Cancello', type: 'gate' },
        { api, log: silentLog(), getWsClient: () => client },
    );
    assert.ok(acc);
    assert.equal(acc.deviceType, fakeDeviceTypes.OnOffOutlet);
});

test('scenario "on" handler triggers the scenario and schedules an auto-off updateAccessoryState', async () => {
    const { api, updates } = makeApi();
    const { client, calls } = makeWsClient();
    const acc = deviceToMatterAccessory(
        { id: 'scenario_42', name: 'Test', type: 'scenario' },
        { api, log: silentLog(), getWsClient: () => client, momentaryAutoOffMs: 25 },
    );
    await acc.handlers.onOff.on();
    assert.deepEqual(calls.triggerScenario, ['scenario_42'], 'trigger must fire immediately');
    assert.equal(updates.length, 0, 'auto-off must be deferred (not synchronous)');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(updates.length, 1, 'auto-off must fire exactly once after the delay');
    assert.deepEqual(updates[0], { uuid: 'scenario_42', clusterName: 'onOff', attributes: { onOff: false }, partId: undefined });
});

test('scenario "off" handler is a no-op (momentary semantics)', async () => {
    const { api, updates } = makeApi();
    const { client, calls } = makeWsClient();
    const acc = deviceToMatterAccessory(
        { id: 'scenario_7', name: 'X', type: 'scenario' },
        { api, log: silentLog(), getWsClient: () => client, momentaryAutoOffMs: 10 },
    );
    await acc.handlers.onOff.off();
    assert.equal(calls.triggerScenario.length, 0, 'off must not trigger the scenario');
    assert.equal(updates.length, 0, 'off must not schedule any state update');
});

test('auto-off rejection is swallowed: trigger already happened, controller must not see an error', async () => {
    const { api } = makeApi({ updateImpl: () => { throw new Error('endpoint not ready'); } });
    const { client, calls } = makeWsClient();
    const acc = deviceToMatterAccessory(
        { id: 'scenario_3', name: 'Y', type: 'scenario' },
        { api, log: silentLog(), getWsClient: () => client, momentaryAutoOffMs: 5 },
    );
    await acc.handlers.onOff.on();
    assert.deepEqual(calls.triggerScenario, ['scenario_3']);
    // Give the scheduled auto-off time to run and reject internally.
    await new Promise((resolve) => setTimeout(resolve, 40));
    // No assertion needed beyond "process did not crash with an unhandled rejection".
});

// Invariant: a Matter-only name is derived; it never reaches the device
// snapshot HomeKit and MQTT share. One direct check per device type.
test('mapping a device to Matter does not change the name (or anything else) of the shared device', () => {
    const { api } = makeApi();
    const { client } = makeWsClient();
    const devices = [
        { id: 'light_1', name: 'Kitchen', description: 'Kitchen', type: 'light', status: { on: true, dimmable: false } },
        { id: 'cover_2', name: 'Kitchen', description: 'Kitchen', type: 'cover', status: { position: 40, state: 'stopped' } },
        { id: 'gate_3', name: 'Gate', description: 'Gate', type: 'gate', status: {} },
        { id: 'scenario_4', name: 'Evening', description: 'Evening', type: 'scenario', status: {} },
        { id: 'zone_5', name: 'Kitchen', description: 'Kitchen', type: 'zone', status: { open: false, armed: false, fault: false, bypassed: false } },
        { id: 'sensor_temp_6', name: 'Kitchen', description: 'Kitchen', type: 'sensor', status: { sensorType: 'temperature', value: 21, unit: 'C' } },
        { id: 'thermostat_7', name: 'Kitchen', description: 'Kitchen', type: 'thermostat', status: { currentTemperature: 20, targetTemperature: 21, mode: 'heat' }, currentTemperature: 20, targetTemperature: 21, mode: 'heat' },
    ];
    for (const device of devices) {
        const before = JSON.stringify(device);
        const accessory = deviceToMatterAccessory(device, {
            api, log: silentLog(), getWsClient: () => client,
            resolveDisplayName: (d) => `${d.name} - Matter only`,
        });
        assert.ok(accessory, `${device.type} is mapped`);
        assert.equal(accessory.displayName, `${device.name} - Matter only`, `${device.type}: the Matter accessory carries the derived name`);
        assert.equal(JSON.stringify(device), before, `${device.type}: the shared device is left as it was`);
    }
});
