'use strict';

// Guards that the rest of the suite exercised without pinning: each of these
// was found by removing the guard and seeing every other test still pass.
// All data is synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readInboundFrame } = require('../dist/websocket-client/inbound-frame.js');
const { DiscoveryService } = require('../dist/platform/discovery-service.js');
const { MqttBridge } = require('../dist/mqtt-bridge/index.js');
const { CommandDispatcher, CommandQueueRejectedError } = require('../dist/websocket/command-dispatcher.js');
const { ThermostatWriteExecutor } = require('../dist/websocket-client/thermostat-write-executor.js');
const { SyncLifecycle } = require('../dist/platform/sync-lifecycle.js');
const { fakeMqtt, recordingLog } = require('./fixtures/fake-mqtt.js');
const { commandClient, settle } = require('./fixtures/command-client.js');
const { waitFor } = require('./fixtures/wait-for.js');

const quietLog = () => ({ info() {}, warn() {}, error() {}, debug() {} });
const settleTicks = async (ticks = 5) => {
    for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('a panel frame without CMD is rejected by the inbound check', () => {
    const outcome = readInboundFrame(JSON.stringify({ ID: '1', PAYLOAD_TYPE: 'REPLY', PAYLOAD: {} }));
    assert.equal(outcome.kind, 'rejected');
    assert.match(outcome.reason, /without CMD/);
});

// The exact comparison has to hold for every exclude list, not only for the outputs.
const device = (id, type) => ({ id, type, name: id, description: id, status: {} });
for (const [key, kept, other, type] of [
    ['excludeZones', 'zone_1', 'zone_11', 'zone'],
    ['excludeOutputs', 'gate_1', 'gate_11', 'gate'],
    ['excludeSensors', 'sensor_temp_1', 'sensor_temp_11', 'sensor'],
    ['excludeScenarios', 'scenario_1', 'scenario_11', 'scenario'],
]) {
    test(`${key} compares ids exactly (1 excludes 1, never 11)`, () => {
        const discovery = new DiscoveryService({ [key]: [1] }, quietLog());
        assert.equal(discovery.isDeviceExcluded(device(kept, type)), true);
        assert.equal(discovery.isDeviceExcluded(device(other, type)), false, `${other} must not match by substring`);
    });
}

test('an object or boolean in an exclude list is reported by its type, never by its content', () => {
    const lines = [];
    const log = { ...quietLog(), warn: (...args) => lines.push(args.map(String).join(' ')) };
    new DiscoveryService({ excludeZones: [{ pin: 'hunter2-synthetic' }, true, ['x-synthetic']] }, log);
    const text = lines.join('\n');
    assert.ok(text.length > 0, 'the dropped entries are reported');
    assert.doesNotMatch(text, /hunter2-synthetic|x-synthetic/);
    assert.match(text, /a value of type object/);
});

// MQTT-3.1.2-22: a CONNECT with a password and no user name is malformed.
test('an MQTT password without a username is not sent to the broker', () => {
    const mqtt = fakeMqtt();
    new MqttBridge(
        { enabled: true, broker: 'mqtt://broker.example', password: 'secret-synthetic' },
        recordingLog().logger,
        { accessoryHandlers: new Map(), config: {} },
        { connect: mqtt.connect },
    );
    assert.equal(mqtt.client.options.password, undefined);
    assert.equal(mqtt.client.options.username, undefined);
});

test('a second scenario trigger while the first is unanswered is refused as busy, one frame is sent', async () => {
    const { client, sent } = commandClient({
        devices: ['scenario_1'],
        options: { commandTimeoutMs: 300 },
        reply: (m, c) => setTimeout(() => c['commandDispatcher'].resolvePendingCommand({
            ID: m.ID, CMD: 'CMD_USR_RES', PAYLOAD_TYPE: 'REPLY', PAYLOAD: { RESULT: 'OK', RESULT_DETAIL: 'CMD_PROCESSED' },
        }), 100),
    });
    const results = await Promise.all([1, 2, 3].map(() => settle(client.triggerScenario('scenario_1'))));
    assert.equal(results[0].ok, true);
    for (const later of results.slice(1)) {
        assert.ok(later.error instanceof CommandQueueRejectedError && later.error.reason === 'busy', String(later.error));
    }
    assert.equal(sent.filter((s) => s.m.CMD === 'CMD_USR').length, 1);
});

// The two guards of triggerScenario (listed category, discovered device) cover each other in the other tests.
test('a scenario listed in exposeScenarios but never listed by the panel is refused and nothing is sent', async () => {
    const { client, sent } = commandClient({ devices: [], options: { exposeScenarios: [{ scenarioId: '9' }] } });
    const outcome = await settle(client.triggerScenario('scenario_9'));
    assert.equal(outcome.ok, false);
    assert.match(String(outcome.error.message), /refused/);
    assert.equal(sent.filter((s) => s.m.CMD === 'CMD_USR').length, 0);
});

function executorHarness(onRead) {
    const sent = [];
    const state = {
        thermostatCfgById: new Map([['7', { ID: '7', ACT_SEA: 'WIN', WIN: { TM: '20.0' }, SUM: { TM: '24.0' } }]]),
        thermostatProgramIdByOutputId: new Map(), thermostatCommandIdByOutputId: new Map(),
        thermostatRealtimeSeasonByOutputId: new Map(), devices: new Map(),
    };
    const send = async (cmd, type) => {
        sent.push([cmd, type]);
        if (cmd === 'READ') onRead?.(state);
        return { status: 'acknowledged' };
    };
    return { executor: new ThermostatWriteExecutor({ state, log: quietLog(), logLevel: 1, send }), sent, state };
}

test('a stale cached cfg is not reused when the panel answers the re-read without it', async () => {
    const { executor, sent } = executorHarness(undefined);
    const batch = { cfgId: '7', intent: { temperature: 21 }, seal() {} };
    await assert.rejects(executor.execute(batch), /could not be read/);
    assert.deepEqual(sent.filter(([cmd]) => cmd === 'WRITE_CFG'), [], 'nothing is written on top of a cfg that was not re-read');
});

test('the thermostat batch is sealed before the payload goes out, so later commands start a new write', async () => {
    const { executor, sent } = executorHarness((state) => {
        state.thermostatCfgById.set('7', { ID: '7', ACT_SEA: 'WIN', WIN: { TM: '20.0' }, SUM: { TM: '24.0' } });
    });
    let sealed = false;
    let sealedWhenSent;
    const batch = { cfgId: '7', intent: { mode: 'heat' }, seal() { sealed = true; } };
    const original = executor.deps.send;
    executor.deps.send = async (cmd, ...rest) => {
        if (cmd === 'WRITE_CFG') sealedWhenSent = sealed;
        return original(cmd, ...rest);
    };
    await executor.execute(batch);
    assert.equal(sealedWhenSent, true);
    assert.equal(sent.filter(([cmd]) => cmd === 'WRITE_CFG').length, 1);
});

// With later commands in the queue the retransmission is replaced anyway: here the device is idle and
// nothing follows, so the DUP is either filtered or executed.
test('a DUP retransmission of an already executed QoS 1 command runs nothing on an idle device', async () => {
    const calls = [];
    const handler = {
        device: { id: 'light_1', type: 'light', name: 'Light', description: 'Light', status: { on: false, dimmable: false } },
        setOn: async (value) => { calls.push(`light_1:${value}`); },
    };
    const mqtt = fakeMqtt();
    new MqttBridge(
        { enabled: true, broker: 'mqtt://broker.example', commands: true },
        recordingLog().logger,
        { accessoryHandlers: new Map([['u', handler]]), config: {} },
        { connect: mqtt.connect },
    );
    mqtt.client.simulateConnect();
    mqtt.client.deliver('homebridge/klares4/light/light_1/set', '{"on":true}', { qos: 1, messageId: 11 });
    await waitFor(() => calls.length === 1);
    await settleTicks();
    mqtt.client.deliver('homebridge/klares4/light/light_1/set', '{"on":true}', { qos: 1, messageId: 11, dup: true });
    await settleTicks();
    assert.deepEqual(calls, ['light_1:true']);
});

// Unbounded, after about 65k commands every 16-bit ID would count as known and no free one would be left.
test('only the most recent finished command IDs stay retired', async () => {
    const dispatcher = new CommandDispatcher();
    for (let id = 1; id <= 300; id += 1) {
        const pending = dispatcher.registerPendingCommand(String(id), 1000);
        dispatcher.resolvePendingCommand({ ID: String(id), CMD: 'CMD_USR_RES', PAYLOAD_TYPE: 'REPLY', PAYLOAD: { RESULT: 'OK' } });
        await pending;
    }
    assert.equal(dispatcher.isKnownCommandId('300'), true, 'the newest finished ID is still remembered');
    assert.equal(dispatcher.isKnownCommandId('1'), false, 'the oldest ones are forgotten');
    assert.equal(dispatcher['retiredCommandIds'].size, 256);
});

test('two completions of the same sync prune Matter once', async () => {
    const pruned = [];
    const lifecycle = new SyncLifecycle({
        log: quietLog(),
        accessoryRegistry: { startDiscoveryCycle() {}, pruneStaleAccessories() {} },
        matterRegistry: {
            setPanelReachable() {}, startDiscoveryCycle() {}, finalizeNameMap: async () => undefined,
            pruneStaleAccessories: async (sync) => { pruned.push(sync); },
        },
        eligibleMatterDevices: () => [],
    });
    lifecycle.startSync();
    lifecycle.handleInitialSyncComplete();
    await waitFor(() => pruned.length === 1);
    lifecycle.handleInitialSyncComplete();
    await settleTicks(10);
    assert.equal(pruned.length, 1);
});
