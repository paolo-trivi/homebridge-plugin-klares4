'use strict';

// PLAT-02 / WS-03 (platform side), the HAP 149-accessory limit, PLAT-06 /
// SP-09 (exclusions on MQTT) and PLAT-09 (shutdown during init), driven
// through the real platform lifecycle against the mock panel.

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '5';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '10';

const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');

const { startMockPanel } = require('./fixtures/lares4-mock-panel.js');
const { createPlatform } = require('./fixtures/platform-session-harness.js');
const { makeHb24MatterApi } = require('./fixtures/hb24-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');

async function panelFor(t, options) {
    const panel = await startMockPanel(options);
    t.after(() => panel.close());
    return panel;
}

const synced = (log) => log.lines.some((line) => line.includes('Initial synchronization completed'));
const errors = (log) => log.lines.filter((line) => line.startsWith('[error]'));

test('PLAT-02: a HAP failure on one device does not stop HAP, Matter or MQTT for the others', async (t) => {
    // No status for light_5: only its discovery can register it on Matter.
    const { DEFAULT_DATA } = require('./fixtures/lares4-mock-panel.js');
    const panel = await panelFor(t, { data: { STATUS_OUTPUTS: DEFAULT_DATA.STATUS_OUTPUTS.filter((o) => o.ID !== '5') } });
    const hb = makeHb24MatterApi();
    const { platform, api, log } = createPlatform(t, {
        port: panel.port,
        matter: hb.api.matter,
        onRegister: (accessories) => {
            if (accessories.some((a) => a.context.device.id === 'light_5')) throw new Error('registration rejected');
        },
    });
    const published = [];
    // MQTT is not enabled in the config, so the platform never replaces this stub.
    platform.mqttBridge = { publishDeviceState: (device) => published.push(device.id), disconnect() {} };
    api.emit('didFinishLaunching');
    await waitFor(() => synced(log));

    for (const id of ['light_6', 'cover_7', 'gate_9', 'scenario_1', 'sensor_temp_1']) {
        assert.ok(api.registered.includes(id), `${id} on HAP`);
    }
    await waitFor(() => hb.registerCalls.some((c) => c.UUID === 'sensor_light_1'));
    const onMatter = hb.registerCalls.map((c) => c.UUID);
    for (const id of ['light_5', 'light_6', 'cover_7', 'scenario_1']) assert.ok(onMatter.includes(id), `${id} on Matter`);
    assert.ok(published.includes('light_6'));
    const lines = errors(log).filter((l) => /light_5/.test(l));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /HAP/);
    assert.match(lines[0], /registration rejected/);
});

test('PLAT-02: MQTT and HAP failures on a status update do not block the other subsystems', async (t) => {
    const panel = await panelFor(t);
    const hb = makeHb24MatterApi();
    const { platform, api, log } = createPlatform(t, { port: panel.port, matter: hb.api.matter });
    const published = [];
    platform.mqttBridge = {
        publishDeviceState: (device) => {
            if (device.id === 'light_6') throw new Error('broker write failed');
            published.push(device.id);
        },
        disconnect() {},
    };
    api.emit('didFinishLaunching');
    await waitFor(() => synced(log));
    await waitFor(() => hb.endpoints.has('light_6') && hb.endpoints.has('zone_1'));
    const registry = platform['accessoryRegistry'];
    registry.updateAccessory = (device) => {
        if (device.id === 'zone_1') throw new Error('HAP update failed');
    };
    hb.updates.length = 0;
    published.length = 0;
    panel.realtime({
        STATUS_OUTPUTS: [{ ID: '6', STA: 'ON' }],
        STATUS_ZONES: [{ ID: '1', STA: 'A', BYP: 'NO', A: 'N', FM: 'F' }],
    });
    await waitFor(() => hb.updates.some((u) => u.uuid === 'light_6' && u.attributes.onOff === true));
    await waitFor(() => hb.updates.some((u) => u.uuid === 'zone_1'));
    assert.ok(published.includes('zone_1'), 'zone_1 published although its HAP update failed');
    assert.ok(errors(log).some((l) => /light_6/.test(l) && /MQTT/.test(l) && /broker write failed/.test(l)));
    assert.ok(errors(log).some((l) => /zone_1/.test(l) && /HAP/.test(l)));
});

test('HAP bridge limit: one clear warning, and the devices beyond it still reach Matter and MQTT', async (t) => {
    const zones = Array.from({ length: 160 }, (_, i) => ({ ID: String(i + 1), DES: `Zone ${i + 1}` }));
    const panel = await panelFor(t, {
        data: {
            ZONES: zones,
            STATUS_ZONES: zones.map((z) => ({ ID: z.ID, STA: 'R', BYP: 'NO', A: 'N', FM: 'F' })),
        },
    });
    const hb = makeHb24MatterApi();
    const bridge = new hap.Bridge('Synthetic Bridge', hap.uuid.generate('synthetic-bridge'));
    const { platform, api, log } = createPlatform(t, { port: panel.port, matter: hb.api.matter, bridge });
    const published = [];
    // MQTT is not enabled in the config, so the platform never replaces this stub.
    platform.mqttBridge = { publishDeviceState: (device) => published.push(device.id), disconnect() {} };
    api.emit('didFinishLaunching');
    await waitFor(() => synced(log));

    assert.equal(bridge.bridgedAccessories.length, 149);
    // 160 zones + 4 outputs + 1 scenario + 3 DOMUS sensors + 2 system sensors.
    await waitFor(() => new Set(hb.registerCalls.map((c) => c.UUID)).size === 170, 10_000);
    assert.ok(published.includes('zone_160') && published.includes('light_5'), 'statuses beyond the limit on MQTT');
    const limitLines = (lines) => lines.filter((l) => /at most 149 accessories/.test(l));
    const warnings = limitLines(log.lines);
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0], /^\[warn\]/);
    assert.match(warnings[0], /Matter/);
    assert.equal(errors(log).length, 0, errors(log).join('\n'));

    // A reconnect re-discovers everything: no new attempt, no new warning.
    const before = bridge.bridgedAccessories.length;
    panel.dropConnections();
    await waitFor(() => panel.logins === 2);
    await waitFor(() => log.lines.filter((l) => l.includes('Initial synchronization completed')).length === 2);
    assert.equal(bridge.bridgedAccessories.length, before);
    assert.equal(limitLines(log.lines).length, 1);
});

test('PLAT-06 / SP-09: an excluded device is neither published on MQTT nor forwarded to Matter or HAP', async (t) => {
    const panel = await panelFor(t);
    const hb = makeHb24MatterApi();
    const { platform, api, log } = createPlatform(t, {
        port: panel.port,
        matter: hb.api.matter,
        config: { excludeZones: ['1'], excludeOutputs: ['5'] },
    });
    const published = [];
    // MQTT is not enabled in the config, so the platform never replaces this stub.
    platform.mqttBridge = { publishDeviceState: (device) => published.push(device.id), disconnect() {} };
    api.emit('didFinishLaunching');
    await waitFor(() => synced(log));
    panel.realtime({
        STATUS_OUTPUTS: [{ ID: '5', STA: 'ON' }, { ID: '6', STA: 'ON' }],
        STATUS_ZONES: [{ ID: '1', STA: 'A', BYP: 'NO', A: 'N', FM: 'F' }],
    });
    await waitFor(() => published.filter((id) => id === 'light_6').length >= 2);

    assert.ok(!published.includes('zone_1'), 'excluded zone not on MQTT');
    assert.ok(!published.includes('light_5'), 'excluded output not on MQTT');
    const matterIds = new Set([...hb.registerCalls.map((c) => c.UUID), ...hb.updates.map((u) => u.uuid)]);
    assert.ok(!matterIds.has('zone_1') && !matterIds.has('light_5'));
    assert.ok(!api.registered.includes('zone_1') && !api.registered.includes('light_5'));
});

test('PLAT-09: a shutdown during initialization stops it before any connection', async (t) => {
    const panel = await panelFor(t);
    const { platform, api, log } = createPlatform(t, { port: panel.port });
    api.emit('didFinishLaunching');
    api.emit('shutdown');
    // Either the init notices the shutdown, or it connects anyway (the defect).
    await waitFor(() => panel.logins > 0 || log.lines.some((l) => /shutting down/i.test(l)));
    assert.equal(platform.wsClient, undefined);
    assert.equal(panel.logins, 0);
    assert.equal(panel.sockets.length, 0);
});
