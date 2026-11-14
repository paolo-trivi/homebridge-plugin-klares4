'use strict';

// Discovery epoch per login (PLAT-04, MAT-02): every login opens a new
// discovery cycle on HAP and Matter, through the real platform lifecycle
// (boot, then reconnects with full or partial syncs). The prune guards
// (family that answered, 3 consecutive syncs, 50% floor) keep protecting.

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '5';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '10';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');

const { startMockPanel } = require('./fixtures/lares4-mock-panel.js');
const { createPlatform, PlatformAccessory } = require('./fixtures/platform-session-harness.js');
const { makeHbMatterApi } = require('./fixtures/hb-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');

const SCENARIOS = [
    { ID: '1', DES: 'Evening', CAT: 'GEN', PIN: 'N' },
    { ID: '3', DES: 'Morning', CAT: 'GEN', PIN: 'N' },
    { ID: '2', DES: 'Arm', CAT: 'ARM', PIN: 'N' },
];

const count = (log, pattern) => log.lines.filter((line) => pattern.test(line)).length;
const syncs = (log) => count(log, /Initial synchronization completed/);
const matterPasses = (log) => count(log, /\[Matter\] (cycle #\d+|Prune skipped for this sync)/);

async function session(t, { failReads = [], matter = true, cached = [], data = {} } = {}) {
    const panel = await startMockPanel({ data: { SCENARIOS, ...data }, failReads });
    t.after(() => panel.close());
    const hb = matter ? makeHbMatterApi() : undefined;
    const { platform, api, log } = createPlatform(t, { port: panel.port, matter: hb?.api.matter });
    for (const device of cached) {
        const accessory = new PlatformAccessory(device.name, hap.uuid.generate(device.id));
        accessory.context.device = device;
        platform.configureAccessory(accessory);
    }
    api.emit('didFinishLaunching');
    await waitFor(() => syncs(log) === 1);
    if (hb) await waitFor(() => matterPasses(log) === 1);
    /** Drops the connection and waits for the next sync (and its Matter pass) to finish. */
    const reconnect = async () => {
        const n = syncs(log);
        const m = matterPasses(log);
        panel.dropConnections();
        await waitFor(() => syncs(log) === n + 1);
        if (hb) await waitFor(() => matterPasses(log) === m + 1);
    };
    return { panel, hb, platform, api, log, reconnect };
}

test('a login opens a new discovery cycle on HAP and Matter', async (t) => {
    const { platform, panel, reconnect } = await session(t);
    const calls = [];
    const hapRegistry = platform['accessoryRegistry'];
    const matterRegistry = platform['matterRegistry'];
    const hapStart = hapRegistry.startDiscoveryCycle.bind(hapRegistry);
    const matterStart = matterRegistry.startDiscoveryCycle.bind(matterRegistry);
    hapRegistry.startDiscoveryCycle = () => { calls.push(['hap', panel.received.filter((m) => m.CMD === 'READ').length]); hapStart(); };
    matterRegistry.startDiscoveryCycle = () => { calls.push(['matter', panel.received.filter((m) => m.CMD === 'READ').length]); matterStart(); };
    const readsBefore = panel.received.filter((m) => m.CMD === 'READ').length;
    await reconnect();
    // Both cycles open before the first READ of the new sync is sent.
    assert.deepEqual(calls, [['hap', readsBefore], ['matter', readsBefore]]);
});

test('PLAT-04: reconnects whose discovery fails never advance the HAP prune counters', async (t) => {
    const ghost = { id: 'light_8', type: 'light', name: 'Old Light', description: '', status: { on: false, dimmable: false } };
    const { panel, api, log, reconnect } = await session(t, { matter: false, cached: [ghost] });
    assert.equal(count(log, /Old Light — absent for 1\/3/), 1, 'boot sync: light family answered');

    // MULTI_TYPES fails: no output of this sync answered (2.2.0 removed light_8 here).
    panel.failReads.add('MULTI_TYPES');
    await reconnect();
    await reconnect();
    assert.equal(count(log, /Old Light — absent for/), 1);
    assert.ok(!api.unregistered.includes('light_8'));

    // Full syncs: the guard counts again, and removal still takes 3 answered syncs.
    panel.failReads.delete('MULTI_TYPES');
    await reconnect();
    assert.equal(count(log, /Old Light — absent for 2\/3/), 1);
    assert.ok(!api.unregistered.includes('light_8'));
    await reconnect();
    assert.ok(api.unregistered.includes('light_8'));
});

test('MAT-02 / PLAT-04: a device removed from the panel is pruned after 3 full syncs without a restart', async (t) => {
    const { panel, hb, api, log, reconnect } = await session(t);
    await waitFor(() => hb.endpoints.has('scenario_1') && hb.endpoints.has('scenario_3'));
    panel.data.SCENARIOS = SCENARIOS.filter((s) => s.ID !== '1');

    await reconnect();
    await reconnect();
    assert.ok(!hb.unregisterCalls.includes('scenario_1'), 'not before the third sync');
    assert.ok(!api.unregistered.includes('scenario_1'));
    assert.equal(count(log, /\[Matter\] Missing candidate: .*scenario_1.* 2\/3/), 1);
    await reconnect();
    await waitFor(() => hb.unregisterCalls.includes('scenario_1'));
    assert.ok(api.unregistered.includes('scenario_1'));
    assert.ok(!hb.unregisterCalls.includes('scenario_3'));
});

test('partial syncs on reconnect remove nothing from Matter or HAP', async (t) => {
    const { panel, hb, api, log, reconnect } = await session(t);
    await waitFor(() => hb.endpoints.has('scenario_1'));
    panel.failReads.add('MULTI_TYPES');
    for (let i = 0; i < 4; i += 1) await reconnect();
    assert.deepEqual(hb.unregisterCalls, []);
    assert.deepEqual(api.unregistered, []);
    assert.equal(count(log, /\[Matter\] cycle #\d+: .*keptFamilyNotAnswered=[1-9]/), 4);
    assert.equal(count(log, /\[Matter\] Missing candidate/), 0);
});

test('a reconnect with an unchanged panel removes nothing', async (t) => {
    const { hb, api, log, reconnect } = await session(t);
    for (let i = 0; i < 4; i += 1) await reconnect();
    assert.deepEqual(hb.unregisterCalls, []);
    assert.deepEqual(api.unregistered, []);
    assert.equal(count(log, /Missing (candidate|accessory)/), 0);
});

test('PLAT-04 / MAT-02: a silent family protects only its own devices; the others are still pruned on Matter', async (t) => {
    const { panel, hb, log, reconnect } = await session(t);
    panel.data.ZONES = [{ ID: '1', DES: 'Zone One' }, { ID: '2', DES: 'Zone Two' }];
    await reconnect();
    await waitFor(() => hb.endpoints.has('zone_2') && hb.endpoints.has('scenario_1'));

    // zone_2 deleted on the panel while MULTI_TYPES (outputs, scenarios, DOMUS) keeps failing.
    panel.data.ZONES = [{ ID: '1', DES: 'Zone One' }];
    panel.failReads.add('MULTI_TYPES');
    for (let i = 0; i < 3; i += 1) await reconnect();
    await waitFor(() => hb.unregisterCalls.includes('zone_2'));
    assert.deepEqual(hb.unregisterCalls, ['zone_2'], 'scenarios, whose family did not answer, stay');
    assert.equal(count(log, /Prune skipped for this sync/), 0, 'the whole-prune skip is gone');
});

test('MAT-02: an endpoint restored from the Matter cache and not on the panel any more is pruned after 3 syncs', async (t) => {
    const cachedScenario = { id: 'scenario_7', type: 'scenario', name: 'Old Scenario', description: '', status: { active: false } };
    const hb = makeHbMatterApi({ restored: [{
        UUID: 'scenario_7', displayName: 'Old Scenario', deviceType: { name: 'OnOffLightSwitch', deviceType: 259, behaviors: { onOff: {} } },
        clusters: { onOff: { onOff: false } },
    }] });
    const panel = await startMockPanel({ data: { SCENARIOS } });
    t.after(() => panel.close());
    const { platform, api, log } = createPlatform(t, { port: panel.port, matter: hb.api.matter });
    platform.configureMatterAccessory({ UUID: 'scenario_7', displayName: 'Old Scenario', deviceType: hb.api.matter.deviceTypes.OnOffSwitch, context: { device: cachedScenario } });
    api.emit('didFinishLaunching');
    await waitFor(() => matterPasses(log) === 1);
    for (let i = 0; i < 2; i += 1) {
        const m = matterPasses(log);
        panel.dropConnections();
        await waitFor(() => matterPasses(log) === m + 1);
    }
    await waitFor(() => hb.unregisterCalls.includes('scenario_7'));
    assert.ok(!hb.endpoints.has('scenario_7'));
    assert.equal(count(log, /Missing candidate: Old Scenario .* [12]\/3/), 2);
});

test('PLAT-04: a system temperature probe reporting NA never counts as missing', async (t) => {
    const probe = { id: 'sensor_system_temp_out', type: 'sensor', name: 'Outdoor probe', description: '', status: { sensorType: 'temperature', value: 9, unit: 'C' } };
    const { api, log, reconnect } = await session(t, {
        matter: false, cached: [probe], data: { STATUS_SYSTEM: [{ ID: '1', TEMP: { IN: '22.0', OUT: 'NA' } }] },
    });
    for (let i = 0; i < 3; i += 1) await reconnect();
    assert.equal(count(log, /Outdoor probe — absent for/), 0);
    assert.ok(!api.unregistered.includes('sensor_system_temp_out'));
});

test('PLAT-02: an accessory HAP refused (bridge limit) leaves no handler behind', async (t) => {
    const panel = await startMockPanel({ data: { SCENARIOS } });
    t.after(() => panel.close());
    const refused = hap.uuid.generate('light_6');
    const { platform, api, log } = createPlatform(t, {
        port: panel.port,
        onRegister: (accessories) => {
            if (accessories.some((a) => a.UUID === refused)) throw new Error('Cannot Bridge more than 149 Accessories');
        },
    });
    api.emit('didFinishLaunching');
    await waitFor(() => syncs(log) === 1);
    assert.ok(api.registered.includes('light_5'));
    assert.equal(platform.accessories.has(refused), false);
    assert.equal(platform.accessoryHandlers.has(refused), false);
});
