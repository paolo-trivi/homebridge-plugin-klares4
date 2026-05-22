/**
 * Integration test for the Matter thermostat echo / loop-prevention fix.
 *
 * Reproduces the production scenario observed at v2.1.3-rc.2:
 *   - user issues a single setpoint change on thermostat_21
 *   - matter.js re-fires the attribute-change handler with the value the plugin
 *     itself just pushed via api.matter.updateAccessoryState
 *   - without origin tracking the handler treats this as an external command and
 *     re-issues setThermostatTemperature, which the centrale broadcasts back,
 *     which re-fires the handler — an infinite loop.
 *
 * The registry-scoped MatterThermostatEchoTracker is responsible for breaking
 * the loop. These tests assert:
 *   1. an internal push that re-fires the handler does NOT generate a WS command;
 *   2. an external (controller-originated) command on thermostat_21 hits cmd 3
 *      and never touches thermostat_20;
 *   3. heating-only cooling-setpoint changes never produce a WS command;
 *   4. a WS-side timeout in the handler does not throw (which would cause the
 *      controller's reactor to mark the call Unhandled and retry).
 */

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

function tmpStorage() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-echo-'));
}

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
};

function silentLog() {
    return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

function makeApi() {
    const registered = []; // captures full MatterAccessory including handlers
    const queryable = new Set();
    const updates = [];
    const matter = {
        deviceTypes: fakeDeviceTypes,
        registerPlatformAccessories: async (_p, _pl, accs) => {
            for (const a of accs) {
                queryable.add(a.UUID);
                registered.push(a);
            }
        },
        updatePlatformAccessories: async () => {},
        updateAccessoryState: async (uuid, cluster, attrs) => {
            updates.push({ uuid, cluster, attrs });
        },
        getAccessoryState: async (uuid) => (queryable.has(uuid) ? {} : undefined),
        unregisterPlatformAccessories: async (_p, _pl, accs) => {
            for (const a of accs) queryable.delete(a.UUID);
        },
    };
    return { api: { matter }, registered, updates };
}

function thermostat(id, name, mode = 'heat', target = 20, current = 21) {
    return { id, type: 'thermostat', name, description: '', currentTemperature: current, targetTemperature: target, mode, status: {} };
}

function makeWsClient() {
    const calls = [];
    return {
        calls,
        async setThermostatTemperature(id, t) { calls.push({ op: 'temp', id, t }); },
        async setThermostatMode(id, mode) { calls.push({ op: 'mode', id, mode }); },
    };
}

async function setup() {
    const { api, registered, updates } = makeApi();
    const ws = makeWsClient();
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => ws, storagePath: tmpStorage() });
    // Heating-only Matrimoniale (cmd 3) and heating-only Bagno (cmd 4)
    await registry.addOrUpdateAccessory(thermostat('thermostat_21', 'Riscaldamento Matrimoniale'));
    await registry.addOrUpdateAccessory(thermostat('thermostat_20', 'Riscaldamento Bagno'));
    await new Promise(r => setTimeout(r, 50)); // wait for probe-settle
    return { registry, api, registered, updates, ws };
}

function getThermostatHandlers(registered, uuid) {
    const acc = registered.find(a => a.UUID === uuid);
    assert.ok(acc, `expected registered accessory ${uuid}`);
    return acc.handlers?.thermostat;
}

test('echo-loop fix: internal state push (matter.js re-firing handler) does NOT trigger WS command', async () => {
    const { registry, registered, ws } = await setup();
    // The plugin pushes new state for thermostat_21 (e.g. centrale broadcast after a CFG change).
    // The mock api's updateAccessoryState records but doesn't actually re-fire the handler —
    // we simulate that by invoking the handler directly with the same value that was pushed.
    await registry.updateAccessoryState(thermostat('thermostat_21', 'Riscaldamento Matrimoniale', 'heat', 24, 21));
    await new Promise(r => setTimeout(r, 50));

    const handlers = getThermostatHandlers(registered, 'thermostat_21');
    // matter.js re-fires occupiedHeatingSetpointChange with the same value (2400 centi)
    await handlers.occupiedHeatingSetpointChange({ occupiedHeatingSetpoint: 2400 });
    assert.equal(ws.calls.length, 0, 'echo must not produce a WS command');
});

test('echo-loop fix: external command on thermostat_21 hits only its own id, never thermostat_20', async () => {
    const { registered, ws } = await setup();
    const handlers21 = getThermostatHandlers(registered, 'thermostat_21');
    // External: a value the plugin has NOT pushed (different from current 20°C)
    await handlers21.occupiedHeatingSetpointChange({ occupiedHeatingSetpoint: 2400 });

    const tempCalls = ws.calls.filter(c => c.op === 'temp');
    assert.equal(tempCalls.length, 1);
    assert.equal(tempCalls[0].id, 'thermostat_21');
    // Crucially: no call to thermostat_20
    assert.equal(ws.calls.some(c => c.id === 'thermostat_20'), false);
});

test('echo-loop fix: heating-only cooling setpoint change does NOT produce a WS command', async () => {
    const { registered, ws } = await setup();
    const handlers = getThermostatHandlers(registered, 'thermostat_21');
    await handlers.occupiedCoolingSetpointChange({ occupiedCoolingSetpoint: 2600 });
    assert.equal(ws.calls.length, 0, 'heating-only cooling change must be a no-op');
});

test('echo-loop fix: idempotent heating change (already current) does NOT produce a WS command', async () => {
    const { registered, ws } = await setup();
    const handlers = getThermostatHandlers(registered, 'thermostat_21');
    // Device currently at 20°C → asking for 20°C must be a no-op
    await handlers.occupiedHeatingSetpointChange({ occupiedHeatingSetpoint: 2000 });
    assert.equal(ws.calls.length, 0);
});

test('echo-loop fix: WS timeout in handler does NOT throw (prevents matter.js reactor retry loop)', async () => {
    const { api, registered } = makeApi();
    const flakyWs = {
        async setThermostatTemperature() {
            throw new Error('Command WRITE_CFG timed out after 2500ms');
        },
        async setThermostatMode() { throw new Error('timeout'); },
    };
    const registry = new MatterAccessoryRegistry({ api, log: silentLog(), getWsClient: () => flakyWs, storagePath: tmpStorage() });
    await registry.addOrUpdateAccessory(thermostat('thermostat_99', 'Riscaldamento Test'));
    await new Promise(r => setTimeout(r, 50));
    const handlers = getThermostatHandlers(registered, 'thermostat_99');
    await assert.doesNotReject(() => handlers.occupiedHeatingSetpointChange({ occupiedHeatingSetpoint: 2400 }));
    await assert.doesNotReject(() => handlers.systemModeChange({ systemMode: 0 }));
});

test('echo-loop fix: external systemMode change uses correct device id and not the other thermostat', async () => {
    const { registered, ws } = await setup();
    const handlers21 = getThermostatHandlers(registered, 'thermostat_21');
    // Device currently 'heat'; ask for OFF (0)
    await handlers21.systemModeChange({ systemMode: 0 });
    const modeCalls = ws.calls.filter(c => c.op === 'mode');
    assert.equal(modeCalls.length, 1);
    assert.equal(modeCalls[0].id, 'thermostat_21');
    assert.equal(modeCalls[0].mode, 'off');
    assert.equal(ws.calls.some(c => c.id === 'thermostat_20'), false);
});

test('echo-loop fix: idempotent systemMode change (already current) does NOT produce a WS command', async () => {
    const { registered, ws } = await setup();
    const handlers = getThermostatHandlers(registered, 'thermostat_21');
    // Device currently 'heat' (matter systemMode 4); asking for 4 again is a no-op
    await handlers.systemModeChange({ systemMode: 4 });
    assert.equal(ws.calls.length, 0);
});
