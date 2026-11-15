'use strict';

// The prune discipline through the real platform lifecycle (F1: PLAT-04,
// MAT-02, PLAT-02): per-family guard, endpoints restored from the Matter
// cache, panel probes reporting NA, accessories HAP refused. Split from
// platform-discovery-epoch.test.js, whose reconnects (1 s each, the
// reconnectInterval minimum) filled the per-file time budget.

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
    /**
     * Drops the connection while MULTI_TYPES is refused and waits for `n`
     * refused syncs: since WS-05 such a sync never completes, the session is
     * closed and retried with the backoff.
     */
    const refusedSyncs = async (n) => {
        const reads = () => panel.received.filter((m) => m.CMD === 'READ' && m.PAYLOAD_TYPE === 'MULTI_TYPES').length;
        const completed = syncs(log);
        const before = reads();
        panel.failReads.add('MULTI_TYPES');
        panel.dropConnections();
        await waitFor(() => reads() >= before + n && count(log, /refused the MULTI_TYPES read/) >= n, 15000);
        assert.equal(syncs(log), completed, 'a refused discovery read never completes the sync');
    };
    return { panel, hb, platform, api, log, reconnect, refusedSyncs };
}

test('PLAT-04 / MAT-02: a silent family protects only its own devices; the others are still pruned on Matter', async (t) => {
    const { panel, hb, api, log, reconnect } = await session(t);
    panel.data.ZONES = [{ ID: '1', DES: 'Zone One' }, { ID: '2', DES: 'Zone Two' }];
    await reconnect();
    await waitFor(() => hb.endpoints.has('zone_2') && hb.endpoints.has('scenario_1'));

    // zone_2 deleted on the panel while MULTI_TYPES (outputs, scenarios, DOMUS) reports nothing.
    // A refused MULTI_TYPES no longer completes a sync (WS-05): the sections are left out instead.
    panel.data.ZONES = [{ ID: '1', DES: 'Zone One' }];
    panel.data = { ...panel.data, OUTPUTS: undefined, SCENARIOS: undefined, BUS_HAS: undefined };
    for (let i = 0; i < 3; i += 1) await reconnect();
    await waitFor(() => hb.unregisterCalls.includes('zone_2'));
    assert.deepEqual(hb.unregisterCalls, ['zone_2'], 'scenarios, whose family did not answer, stay');
    assert.deepEqual(api.unregistered.filter((id) => id.startsWith('scenario_')), [], 'on HomeKit too');
    assert.ok(count(log, /\[Matter\] cycle #\d+: .*keptFamilyNotAnswered=[1-9]/) >= 3);
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
