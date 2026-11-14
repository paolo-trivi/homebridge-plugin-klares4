'use strict';

// Contract with the Homebridge Matter stack installed in node_modules: every
// accessory the plugin's mapper produces must be accepted by the real
// HomebridgeAPI/MatterServer/matter.js, end up on the bridge with the expected
// device type and answer reads. The in-memory fixture (hb-matter-api.js)
// cannot see conformance errors; this file can.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '2000';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '10';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '50';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '10';

const { deviceToMatterAccessory, mapThermostatAsTemperatureSensor } = require('../dist/platform/matter-device-mapper.js');
const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');
const { REAL_DEVICE_TYPES } = require('./fixtures/hb-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const PLUGIN = 'homebridge-plugin-klares4';
const PLATFORM = 'Lares4Complete';
const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });

function wsClient() {
    const calls = [];
    const record = (op) => async (...args) => { calls.push([op, ...args]); };
    return {
        calls,
        switchLight: record('switchLight'),
        dimLight: record('dimLight'),
        moveCover: record('moveCover'),
        triggerScenario: record('triggerScenario'),
        toggleGate: record('toggleGate'),
        setThermostatTemperature: record('setThermostatTemperature'),
        setThermostatMode: record('setThermostatMode'),
    };
}

const D = {
    light: (n, on = false) => ({ id: `light_${n}`, type: 'light', name: `Luce prova ${n}`, description: '', status: { on, dimmable: false } }),
    dimmer: (n) => ({ id: `light_${n}`, type: 'light', name: `Faretto prova ${n}`, description: '', status: { on: true, dimmable: true, brightness: 40 } }),
    cover: (n) => ({ id: `cover_${n}`, type: 'cover', name: `Tapparella prova ${n}`, description: '', status: { position: 30, state: 'stopped' } }),
    gate: (n) => ({ id: `gate_${n}`, type: 'gate', name: `Cancello prova ${n}`, description: '', status: { on: false } }),
    zone: (n) => ({ id: `zone_${n}`, type: 'zone', name: `Finestra prova ${n}`, description: '', status: { armed: false, bypassed: false, fault: false, open: false } }),
    sensor: (kind, n, value) => ({ id: `sensor_${kind}_${n}`, type: 'sensor', name: `Sensore ${kind} ${n}`, description: '', status: { sensorType: kind, value } }),
    scenario: (n) => ({ id: `scenario_${n}`, type: 'scenario', name: `Scenario prova ${n}`, description: '', status: { active: false } }),
    thermostat: (n) => {
        const status = { currentTemperature: 20, targetTemperature: 21, mode: 'heat' };
        return { id: `thermostat_${n}`, type: 'thermostat', name: `Termostato prova ${n}`, description: '', ...status, status };
    },
};

// Every branch of deviceToMatterAccessory, with the device type name the real
// Homebridge gives the endpoint and the cluster that carries its state.
const CASES = [
    { label: 'on/off light', device: D.light(1), type: 'OnOffLight', cluster: 'onOff' },
    { label: 'dimmer', device: D.dimmer(2), type: 'DimmableLight', cluster: 'levelControl' },
    { label: 'cover', device: D.cover(3), type: 'WindowCovering', cluster: 'windowCovering' },
    { label: 'gate', device: D.gate(4), type: 'OnOffPlugInUnit', cluster: 'onOff' },
    { label: 'zone', device: D.zone(5), type: 'ContactSensor', cluster: 'booleanState' },
    { label: 'temperature sensor', device: D.sensor('temperature', 6, 21.5), type: 'TemperatureSensor', cluster: 'temperatureMeasurement' },
    { label: 'humidity sensor', device: D.sensor('humidity', 7, 48), type: 'HumiditySensor', cluster: 'relativeHumidityMeasurement' },
    { label: 'light sensor', device: D.sensor('light', 8, 320), type: 'LightSensor', cluster: 'illuminanceMeasurement' },
    { label: 'motion sensor', device: D.sensor('motion', 9, 1), type: 'OccupancySensor', cluster: 'occupancySensing' },
    { label: 'contact sensor', device: D.sensor('contact', 10, 0), type: 'ContactSensor', cluster: 'booleanState' },
    { label: 'scenario', device: D.scenario(11), type: 'OnOffPlugInUnit', cluster: 'onOff' },
];

function mapperDeps(stack, ws = wsClient()) {
    return { api: stack.api, log: silentLog(), getWsClient: () => ws, momentaryAutoOffMs: 5 };
}

async function registerOnRealStack(stack, accessory) {
    await stack.api.matter.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
    return stack.record(accessory.UUID);
}

function assertOnBridge(stack, uuid, type, cluster) {
    const record = stack.record(uuid);
    assert.ok(record, `${uuid} is not on the bridge; Homebridge said: ${stack.hbLines.filter((l) => /fail|error/i.test(l)).join(' | ')}`);
    assert.equal(stack.deviceTypeName(uuid), type);
    assert.ok(stack.read(uuid, cluster), `${uuid}.${cluster} is not readable`);
    assert.equal(stack.read(uuid, 'bridgedDeviceBasicInformation')?.reachable, true);
}

for (const { label, device, type, cluster } of CASES) {
    test(`real stack: a mapped ${label} registers as ${type} and answers reads`, { timeout: 30000 }, async (t) => {
        const stack = await realMatterStackSession(t).start();
        const accessory = deviceToMatterAccessory(device, mapperDeps(stack));
        assert.ok(accessory, 'the mapper produces an accessory');
        await registerOnRealStack(stack, accessory);
        assertOnBridge(stack, device.id, type, cluster);
    });
}

test('real stack: a mapped thermostat registers as a native Thermostat', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const device = D.thermostat(12);
    await registerOnRealStack(stack, deviceToMatterAccessory(device, mapperDeps(stack)));
    assertOnBridge(stack, device.id, 'Thermostat', 'thermostat');
});

test('real stack: the thermostat fallback registers as TemperatureSensor', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const device = D.thermostat(13);
    await registerOnRealStack(stack, mapThermostatAsTemperatureSensor(device, mapperDeps(stack)));
    assertOnBridge(stack, device.id, 'TemperatureSensor', 'temperatureMeasurement');
});

test('real stack: the harness never binds a host socket (matter.js mDNS stays in its network simulator)', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    await registerOnRealStack(stack, deviceToMatterAccessory(D.light(14), mapperDeps(stack)));
    assert.equal(stack.hostSocketsBound(), 0);
});

test('real stack: controller commands reach the plugin handlers through the Homebridge behaviors', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const ws = wsClient();
    const deps = mapperDeps(stack, ws);
    for (const device of [D.light(15), D.cover(16), D.scenario(17)]) {
        await registerOnRealStack(stack, deviceToMatterAccessory(device, deps));
    }
    await stack.invoke('light_15', 'onOff', 'on', {});
    await stack.invoke('cover_16', 'windowCovering', 'goToLiftPercentage', { liftPercent100thsValue: 2500 });
    await stack.invoke('scenario_17', 'onOff', 'on', {});
    assert.deepEqual(ws.calls, [
        ['switchLight', 'light_15', true],
        ['moveCover', 'cover_16', 75],
        ['triggerScenario', 'scenario_17'],
    ]);
});

test('real stack: the plugin registry survives a Homebridge restart by attaching to the cached endpoints', { timeout: 60000 }, async (t) => {
    const session = realMatterStackSession(t);
    const devices = [D.light(20), D.cover(21), D.zone(22)];
    const storagePath = tmpStorage(t, 'klares4-contract-');

    const boot1 = await session.start();
    const registry1 = new MatterAccessoryRegistry({ api: boot1.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    registry1.startDiscoveryCycle();
    for (const device of devices) await registry1.addOrUpdateAccessory(device);
    await waitFor(() => devices.every((d) => registry1.getStatus(d.id) === 'registered'), 10000);
    await boot1.stop();

    const boot2 = await session.start();
    const cached = boot2.cached();
    assert.deepEqual(cached.map((c) => c.UUID).sort(), devices.map((d) => d.id).sort());
    const unregisterSpy = t.mock.method(boot2.api.matter, 'unregisterPlatformAccessories');
    const registry2 = new MatterAccessoryRegistry({ api: boot2.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    for (const accessory of cached) registry2.configureCachedAccessory(accessory);
    registry2.startDiscoveryCycle();
    for (const device of devices) await registry2.addOrUpdateAccessory(device);
    await waitFor(() => devices.every((d) => registry2.getStatus(d.id) === 'registered'), 10000);

    assert.equal(unregisterSpy.mock.callCount(), 0, 'a normal restart unregisters nothing');
    assert.ok(boot2.hbLines.some((l) => l.includes('Attached plugin registration to restored accessory')));
    assertOnBridge(boot2, 'light_20', 'OnOffLight', 'onOff');
    assertOnBridge(boot2, 'cover_21', 'WindowCovering', 'windowCovering');
    assertOnBridge(boot2, 'zone_22', 'ContactSensor', 'booleanState');
});

// The fixture used by the rest of the suite must not drift from the real API.
test('fixture fidelity: hb-matter-api.js offers exactly the real device types the mapper needs', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const real = stack.api.matter.deviceTypes;
    for (const [key, [name, code]] of Object.entries(REAL_DEVICE_TYPES)) {
        assert.ok(real[key], `deviceTypes.${key} does not exist in the installed Homebridge`);
        assert.equal(real[key].name, name, `deviceTypes.${key}.name`);
        assert.equal(Number(real[key].deviceType), code, `deviceTypes.${key} code`);
    }
});

test('fixture fidelity: the API calls behave as the fixture models them', { timeout: 30000 }, async (t) => {
    const stack = await realMatterStackSession(t).start();
    const matter = stack.api.matter;
    // updateAccessoryState on an unknown UUID or cluster resolves; Homebridge only logs.
    await matter.updateAccessoryState('missing_1', 'onOff', { onOff: true });
    const light = deviceToMatterAccessory(D.light(30), mapperDeps(stack));
    await registerOnRealStack(stack, light);
    await matter.updateAccessoryState('light_30', 'temperatureMeasurement', { measuredValue: 1 });
    // register resolves once the endpoint exists.
    assert.ok(stack.record('light_30'));
    // an accessory without serialNumber is dropped by validation; the call resolves.
    const { serialNumber: _dropped, ...noSerial } = deviceToMatterAccessory(D.light(31), mapperDeps(stack));
    await matter.registerPlatformAccessories(PLUGIN, PLATFORM, [noSerial]);
    assert.equal(stack.record('light_31'), undefined);
    // a duplicate UUID is refused and only logged; the call resolves.
    await matter.registerPlatformAccessories(PLUGIN, PLATFORM, [deviceToMatterAccessory(D.light(30), mapperDeps(stack))]);
    assert.ok(stack.hbLines.some((l) => l.includes('already registered')));
    // unregister with a bare { UUID } stub throws before removing anything.
    await assert.rejects(matter.unregisterPlatformAccessories(PLUGIN, PLATFORM, [{ UUID: 'light_30' }]), TypeError);
    assert.ok(stack.record('light_30'));
    // unregister resolves once the endpoint is gone.
    await matter.unregisterPlatformAccessories(PLUGIN, PLATFORM, [light]);
    assert.equal(stack.record('light_30'), undefined);
    assert.equal(await matter.getAccessoryState('light_30', 'onOff'), undefined);
});
