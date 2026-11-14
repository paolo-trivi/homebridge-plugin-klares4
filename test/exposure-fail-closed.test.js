'use strict';

// Fail-closed exposure (WS-01 / PLAT-05, WS-02 / PLAT-01): outputs of an
// unrecognized category and scenarios outside the allowlist never enter the
// client state; `exposeOutputs` / `exposeScenarios` bring them back one by one.

const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { DiscoveryReadHandler } = require('../dist/websocket-client/discovery-read-handler.js');
const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');
const { isHiddenByExposurePolicy } = require('../dist/websocket-client/exposure-report.js');
const { resolveOutputExposure } = require('../dist/websocket/output-classifier.js');
const { recordingLog } = require('./fixtures/lares4-mock-panel.js');

// Shapes seen on real panels (CAT/MOD pairs), with synthetic names.
const OUTPUTS = [
    { ID: '1', DES: 'Hall light', CAT: 'LIGHT', MOD: 'B' },
    { ID: '2', DES: 'Siren', CAT: 'GEN', MOD: 'AT' },
    { ID: '3', DES: 'Alarm bridge', CAT: 'GEN', MOD: 'A' },
    { ID: '4', DES: 'Indicator', CAT: 'GEN', MOD: 'S' },
    { ID: '5', DES: 'Door strike', CAT: 'GEN', MOD: 'M' },
    { ID: '6', DES: 'Sprinkler', CAT: 'IRR', MOD: 'M' },
    { ID: '7', DES: 'Mystery' },
    { ID: '8', DES: 'Numeric category', CAT: 2 },
    { ID: '9', DES: 'Shutter', CAT: 'ROLL', MOD: 'BDP' },
    { ID: '10', DES: 'Driveway', CAT: 'gate', MOD: 'm' },
    { ID: '11', DES: 'Siren two', CAT: 'SIREN', MOD: 'B' },
];

const SCENARIOS = [
    { ID: '1', DES: 'Evening', CAT: 'GEN', PIN: 'N' },
    { ID: '2', DES: 'Arm all', CAT: 'ARM', PIN: 'N' },
    { ID: '3', DES: 'Away', CAT: 'ARM_AWAY', PIN: 'P' },
    { ID: '4', DES: 'No category', PIN: 'P' },
    { ID: '5', DES: 'Lights off', CAT: 'GEN', PIN: 'PR' },
];

function multiTypes(payload) {
    return {
        CMD: 'READ_RES', ID: '10', SENDER: 'p', RECEIVER: '', TIMESTAMP: '0', CRC_16: '0x0000',
        PAYLOAD_TYPE: 'MULTI_TYPES', PAYLOAD: { RESULT: 'OK', ...payload },
    };
}

function createClient(log = recordingLog()) {
    const client = new KseniaWebSocketClient('127.0.0.1', 1, false, 'hb', '1234', log, {});
    const discovered = [];
    client.onDeviceDiscovered = (device) => discovered.push(device.id);
    return { client, discovered, log };
}

function createHandler({ exposeOutputs, exposeScenarios, exposePartialArmScenarios } = {}) {
    const state = createInitialWebSocketClientState();
    const log = recordingLog();
    const discovered = [];
    const handler = new DiscoveryReadHandler({
        state,
        log,
        exposePartialArmScenarios,
        exposeOutputs,
        exposeScenarios,
        statusUpdater: { applyPendingOutputStatus() {}, applyPendingSensorStatus() {} },
        thermostats: { recordOutput() {} },
        emitDeviceDiscovered: (device) => discovered.push(device),
    });
    return { handler, state, log, discovered };
}

const warnings = (log) => log.lines.filter((line) => line.startsWith('[warn]'));

test('WS-01: only outputs of a recognized category enter the client state', () => {
    const { client, discovered } = createClient();
    client['messageService'].handleReadResponse(multiTypes({ OUTPUTS }));

    assert.deepEqual(discovered, ['light_1', 'cover_9', 'gate_10']);
    const ids = [...client['state'].devices.keys()];
    for (const id of ['2', '3', '4', '5', '6', '7', '8', '11']) {
        assert.ok(!ids.some((deviceId) => deviceId.endsWith(`_${id}`)), `output ${id} must not be in the client state`);
        assert.equal(isHiddenByExposurePolicy(client['state'], `light_${id}`), true, `output ${id} recorded as hidden`);
    }
    assert.equal(isHiddenByExposurePolicy(client['state'], 'light_1'), false);
});

test('WS-01: an output whose category stops being recognized leaves the client state', () => {
    const { client, discovered } = createClient();
    client['messageService'].handleReadResponse(multiTypes({ OUTPUTS: [{ ID: '21', DES: 'Relay', CAT: 'LIGHT' }] }));
    assert.ok(client['state'].devices.has('light_21'));

    client['messageService'].handleReadResponse(multiTypes({ OUTPUTS: [{ ID: '21', DES: 'Relay', CAT: 'GEN', MOD: 'M' }] }));
    assert.equal(client['state'].devices.has('light_21'), false);
    // A re-read without a category does not bring the earlier type back either.
    client['messageService'].handleReadResponse(multiTypes({ OUTPUTS: [{ ID: '21', DES: 'Relay' }] }));
    assert.equal(client['state'].devices.has('light_21'), false);
    assert.deepEqual(discovered, ['light_21']);
});

test('WS-01: a known gate keeps its type when a re-read lacks the category', () => {
    const output = { ID: '22', DES: 'Gate', CAT: 'GATE', MOD: 'M' };
    assert.deepEqual(resolveOutputExposure(output, new Map()), { exposed: true, type: 'gate', source: 'category' });
    assert.deepEqual(resolveOutputExposure({ ID: '22', DES: 'Gate' }, new Map()), { exposed: true, type: 'gate', source: 'category' });
});

test('WS-01: exposeOutputs re-exposes one output as a light with its 2.2.0 device ID', () => {
    const { handler, discovered, state, log } = createHandler({ exposeOutputs: [{ outputId: '5', exposeAs: 'light' }] });
    handler.handleOutputs(OUTPUTS);
    handler.handleScenarios([]);

    const light = discovered.find((device) => device.id === 'light_5');
    assert.ok(light, 'the opted-in output is discovered');
    assert.equal(light.type, 'light');
    assert.equal(light.name, 'Door strike');
    assert.equal(isHiddenByExposurePolicy(state, 'light_5'), false);
    assert.equal(isHiddenByExposurePolicy(state, 'light_2'), true, 'other GEN outputs stay hidden');
    assert.equal(discovered.filter((device) => device.id.endsWith('_2')).length, 0);
    assert.doesNotMatch(warnings(log).join('\n'), /"outputId":"5"/);
});

test('WS-01 / WS-02: one startup warning lists hidden devices with copyable config lines', () => {
    const { handler, log } = createHandler();
    handler.handleOutputs(OUTPUTS);
    handler.handleScenarios(SCENARIOS);

    const warns = warnings(log);
    assert.equal(warns.length, 1, warns.join('\n'));
    const warning = warns[0];
    assert.match(warning, /output 2 "Siren" \(category GEN, mode AT\)/);
    assert.match(warning, /output 7 "Mystery" \(category none\)/);
    assert.match(warning, /scenario 3 "Away" \(category ARM_AWAY\)/);
    assert.match(warning, /scenario 4 "No category" \(category none\)/);
    assert.doesNotMatch(warning, /scenario 2 /, 'ARM is never opt-in-able, so it is not offered');

    const outputsLine = warning.split('\n').find((line) => line.includes('"exposeOutputs"'));
    const scenariosLine = warning.split('\n').find((line) => line.includes('"exposeScenarios"'));
    const config = JSON.parse(`{${outputsLine}, ${scenariosLine}}`);
    assert.deepEqual(config.exposeOutputs.map((row) => row.outputId), ['2', '3', '4', '5', '6', '7', '8', '11']);
    assert.ok(config.exposeOutputs.every((row) => row.exposeAs === 'light'));
    assert.deepEqual(config.exposeScenarios, [{ scenarioId: '3' }, { scenarioId: '4' }]);

    // The PIN flag is recorded and reported for exposed scenarios, never used to hide them.
    assert.match(warning, /scenario 5 "Lights off" \(category GEN, PIN flag PR\)/);
});

test('WS-01 / WS-02: a reconnect that finds the same hidden devices does not warn again', () => {
    const { handler, log } = createHandler();
    for (let i = 0; i < 3; i += 1) {
        handler.handleOutputs(OUTPUTS);
        handler.handleScenarios(SCENARIOS);
    }
    assert.equal(warnings(log).length, 1);
});

test('WS-01: hidden outputs are reported even when the read has no SCENARIOS', () => {
    const { handler, log } = createHandler();
    handler.handleOutputs(OUTPUTS);
    handler.handleBusSensors([]);
    assert.equal(warnings(log).length, 1);
});

test('WS-02: only GEN scenarios are discovered without an opt-in; the PIN flag is kept', () => {
    const { client, discovered } = createClient();
    client['messageService'].handleReadResponse(multiTypes({ SCENARIOS }));
    assert.deepEqual(discovered, ['scenario_1', 'scenario_5']);
    assert.equal(client['state'].devices.get('scenario_5').pinFlag, 'PR');
    assert.equal(client['state'].devices.get('scenario_1').pinFlag, 'N');
    for (const id of ['2', '3', '4']) assert.equal(isHiddenByExposurePolicy(client['state'], `scenario_${id}`), true);
});

test('WS-02: exposeScenarios exposes an unknown category, never ARM/DISARM nor PARTIAL', () => {
    const { handler, discovered, log } = createHandler({
        exposeScenarios: [{ scenarioId: '3' }, { scenarioId: '2' }, { scenarioId: '6' }, { scenarioId: '1' }, { scenarioId: '99' }],
    });
    handler.handleScenarios([...SCENARIOS, { ID: '6', DES: 'Night', CAT: 'PARTIAL', PIN: 'P' }]);

    assert.deepEqual(discovered.map((device) => device.id), ['scenario_1', 'scenario_3', 'scenario_5']);
    const warning = warnings(log).join('\n');
    assert.match(warning, /scenario 2 "Arm all" \(category ARM\) arms or disarms the alarm and is never exposed/);
    assert.match(warning, /scenario 6 "Night" \(category PARTIAL\) partially arms the alarm: only exposePartialArmScenarios/);
    assert.match(warning, /scenario 1 "Evening" \(category GEN\) is exposed without it/);
    assert.match(warning, /scenario 99 is not listed by the panel/);
    assert.match(warning, /scenario 3 "Away" \(category ARM_AWAY, PIN flag P\)/, 'an opted-in scenario with a PIN flag is reported');
});

test('WS-01: exposeOutputs rows that change nothing are reported', () => {
    const { handler, log } = createHandler({ exposeOutputs: [{ outputId: '1', exposeAs: 'light' }, { outputId: '77', exposeAs: 'light' }] });
    handler.handleOutputs(OUTPUTS);
    handler.handleScenarios([]);
    const warning = warnings(log).join('\n');
    assert.match(warning, /output 1 is exposed as light without it/);
    assert.match(warning, /output 77 is not listed by the panel/);
});

test('WS-01 / WS-02: through the platform, hidden outputs and scenarios reach neither HAP nor the device list', async (t) => {
    const { startMockPanel, DEFAULT_DATA } = require('./fixtures/lares4-mock-panel.js');
    const { createPlatform } = require('./fixtures/platform-session-harness.js');
    const { waitFor } = require('./fixtures/wait-for.js');
    const panel = await startMockPanel({
        data: {
            OUTPUTS: [...DEFAULT_DATA.OUTPUTS, { ID: '12', DES: 'Siren', CAT: 'GEN', MOD: 'AT' }, { ID: '13', DES: 'Valve', CAT: 'IRR', MOD: 'M' }],
            SCENARIOS: [...DEFAULT_DATA.SCENARIOS, { ID: '3', DES: 'Away', CAT: 'ARM_AWAY', PIN: 'P' }],
        },
    });
    t.after(() => panel.close());
    const { platform, api, log } = createPlatform(t, { port: panel.port });
    api.emit('didFinishLaunching');
    await waitFor(() => log.lines.some((line) => /Initial synchronization completed/.test(line)));

    assert.ok(api.registered.includes('light_5'));
    assert.ok(api.registered.includes('scenario_1'));
    for (const id of ['light_12', 'light_13', 'scenario_3']) {
        assert.equal(api.registered.includes(id), false, `${id} must not be registered on HAP`);
    }
    const hidden = log.lines.filter((line) => line.startsWith('[warn]') && line.includes('Exposure policy'));
    assert.equal(hidden.length, 1);
    assert.match(hidden[0], /"exposeOutputs": \[\{"outputId":"12","exposeAs":"light"\}, \{"outputId":"13","exposeAs":"light"\}\]/);
    assert.match(hidden[0], /"exposeScenarios": \[\{"scenarioId":"3"\}\]/);
    assert.equal(platform.wsClient.isScenarioSuppressed('scenario_3'), true);
});
