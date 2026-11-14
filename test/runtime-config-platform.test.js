'use strict';

// The platform wiring of the runtime config: one validation at startup, the
// client and the Matter registry fed from validated values, hostile configs
// never stopping the plugin, and the end-of-sync report of useless overrides.

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { startMockPanel } = require('./fixtures/lares4-mock-panel.js');
const { createPlatform } = require('./fixtures/platform-session-harness.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');

const lines = (log, level) => log.lines.filter((l) => l.startsWith(`[${level}]`));
const syncs = (log) => log.lines.filter((l) => l.includes('Initial synchronization completed')).length;

function closedPort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/** A platform that has started its client (against a port nobody listens on). */
async function startedPlatform(t, config) {
    const port = await closedPort();
    const created = createPlatform(t, { port, config: { reconnectInterval: 60_000, ...config } });
    created.api.emit('didFinishLaunching');
    await waitFor(() => created.platform.wsClient);
    return created;
}

test('WS-09: allowInsecureTls "false" or "true" leaves TLS verification on, and the config is reported once', async (t) => {
    for (const value of ['false', 'true']) {
        const { platform, log } = await startedPlatform(t, { https: true, allowInsecureTls: value });
        assert.equal(platform.wsClient.options.allowInsecureTls, false, JSON.stringify(value));
        assert.equal(platform.config.allowInsecureTls, false);
        assert.equal(lines(log, 'warn').filter((l) => /verification is disabled/.test(l)).length, 0);
        const reports = lines(log, 'warn').filter((l) => /allowInsecureTls/.test(l));
        assert.equal(reports.length, 1);
        assert.match(reports[0], /received string/);
    }
    const { platform, log } = await startedPlatform(t, { https: true, allowInsecureTls: true });
    assert.equal(platform.wsClient.options.allowInsecureTls, true);
    assert.equal(lines(log, 'warn').filter((l) => /verification is disabled/.test(l)).length, 1);
});

test('PLAT-01: exposePartialArmScenarios "true" and 1 reach the client as false', async (t) => {
    for (const value of ['true', 1]) {
        const { platform } = await startedPlatform(t, { exposePartialArmScenarios: value });
        assert.equal(platform.wsClient.options.exposePartialArmScenarios, false);
    }
    const { platform } = await startedPlatform(t, { exposePartialArmScenarios: true });
    assert.equal(platform.wsClient.options.exposePartialArmScenarios, true);
});

test('WS-09: reconnectInterval 0 or -5 and heartbeatInterval 0 reach the client at the schema minimum', async (t) => {
    for (const reconnectInterval of [0, -5, 'soon', null]) {
        const { platform } = await startedPlatform(t, { reconnectInterval, heartbeatInterval: 0 });
        const { options } = platform.wsClient;
        assert.equal(options.reconnectInterval, reconnectInterval === 'soon' || reconnectInterval === null ? 5000 : 1000, String(reconnectInterval));
        assert.equal(options.heartbeatInterval, 10000);
    }
});

test('TD-DOC-15: matterUnregisterTimeoutMs is held to the documented 500..30000 range', async (t) => {
    const timeoutOf = (config) => createPlatform(t, { config: { ...config } }).platform.matterRegistry.topologyCoordinator.unregisterTimeoutMs;
    assert.equal(timeoutOf({ matterUnregisterTimeoutMs: 1 }), 500);
    assert.equal(timeoutOf({ matterUnregisterTimeoutMs: 999999 }), 30000);
    assert.equal(timeoutOf({ matterUnregisterTimeoutMs: 4000 }), 4000);
    assert.equal(timeoutOf({}), 3000);
});

test('the client defaults cannot be erased by an explicit undefined, and its security switches need a real true', () => {
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    const client = new KseniaWebSocketClient('127.0.0.1', 1, false, 'sender', '1234', log, {
        reconnectInterval: undefined, heartbeatInterval: undefined, commandTimeoutMs: undefined, debug: undefined,
        loginTimeoutMs: undefined, connectTimeoutMs: undefined, allowInsecureTls: 'false', exposePartialArmScenarios: 'true',
    });
    const { options } = client;
    assert.equal(options.reconnectInterval, 5000);
    assert.equal(options.heartbeatInterval, 30000);
    assert.equal(options.commandTimeoutMs, 8000);
    assert.equal(options.loginTimeoutMs, 10000);
    assert.equal(options.connectTimeoutMs, 10000);
    assert.equal(options.debug, false);
    assert.equal(options.allowInsecureTls, false);
    assert.equal(options.exposePartialArmScenarios, false);
});

test('an unusable PIN type is one clear error, with no value and no second "PIN missing"', (t) => {
    const { log, api } = createPlatform(t, { config: { pin: { digits: 'PIN-VALUE-XYZ' } } });
    const errors = lines(log, 'error');
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /pin/i);
    assert.doesNotMatch(log.lines.join('\n'), /PIN-VALUE-XYZ/);
    assert.equal(api.emit('didFinishLaunching'), undefined, 'the platform does not start');
});

test('a missing PIN is still reported as missing', (t) => {
    const { log } = createPlatform(t, { config: { pin: undefined } });
    assert.ok(lines(log, 'error').some((l) => /PIN missing in configuration/.test(l)));
});

test('PLAT-10, MAT-09, PLAT-06: a hostile config starts the platform, syncs and reports instead of throwing', async (t) => {
    const panel = await startMockPanel();
    t.after(() => panel.close());
    let created;
    assert.doesNotThrow(() => {
        created = createPlatform(t, {
            port: panel.port,
            config: {
                matterOverrides: { zone_1: null, light_5: 'x', cover_7: { exposed: false } },
                matterRecoveryRequests: { thermostat_1: null },
                customNames: { zones: { 1: 42 }, outputs: { 6: ['x'] } },
                excludeOutputs: {},
                excludeZones: 'zone_1',
                mqtt: { enabled: false, broker: 'mqtt://b', qos: 9 },
            },
        });
    });
    const { platform, api, log } = created;
    created.api.emit('didFinishLaunching');
    await waitFor(() => syncs(log) >= 1);
    assert.deepEqual(lines(log, 'error'), []);
    assert.ok(api.registered.includes('zone_1'), 'a string excludeZones excludes nothing');
    assert.ok(api.registered.includes('gate_9'));
    assert.equal(platform.runtimeConfig.mqtt.qos, 1);
    const config = lines(log, 'warn').filter((l) => /^\[warn\] Configuration: \d+ value/.test(l));
    assert.equal(config.length, 1, 'validation warnings are grouped into one entry');
    for (const key of ['matterOverrides.zone_1', 'matterRecoveryRequests.thermostat_1', 'customNames.zones', 'excludeOutputs', 'excludeZones', 'mqtt.qos']) {
        assert.ok(config[0].includes(key), key);
    }
});

test('MAT-10: after the first sync one warning lists what matches nothing; it is not repeated by the next sync', async (t) => {
    const panel = await startMockPanel();
    t.after(() => panel.close());
    const { api, log } = createPlatform(t, {
        port: panel.port,
        config: {
            matterOverrides: [
                { deviceId: 'ZONE_1', exposed: false }, { deviceId: '6', name: 'Typo' },
                { deviceId: 'cover_7', exposed: false }, { deviceId: 'light_404', exposed: false },
            ],
            matterRecoveryRequests: [{ deviceId: 'thermostat_77', generation: 1 }],
            customNames: [{ deviceId: 'light_5', name: 'Lamp' }, { deviceId: 'zone_404', name: 'Ghost' }],
        },
    });
    api.emit('didFinishLaunching');
    await waitFor(() => syncs(log) >= 1);
    const unmatched = () => lines(log, 'warn').filter((l) => /match no device/.test(l));
    assert.equal(unmatched().length, 1);
    const text = unmatched()[0];
    assert.match(text, /"ZONE_1" \(did you mean zone_1\?\)/);
    assert.match(text, /"6" \(did you mean light_6\?\)/);
    assert.match(text, /"light_404"/);
    assert.match(text, /thermostat_77/);
    assert.match(text, /zone_404/);
    assert.doesNotMatch(text.split('\n').slice(1).join('\n'), /cover_7|light_5/);
    const hides = lines(log, 'warn').filter((l) => /matterOverrides hides/.test(l));
    assert.equal(hides.length, 1);
    assert.match(hides[0], /hides 1 device\(s\) from Matter: cover_7/);

    panel.dropConnections();
    await waitFor(() => syncs(log) >= 2);
    assert.equal(unmatched().length, 1, 'reported once per start');
    assert.equal(lines(log, 'warn').filter((l) => /matterOverrides hides/.test(l)).length, 1);
});
