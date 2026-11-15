'use strict';

// Partial and degraded syncs through the real platform lifecycle (PLAT-04,
// COMMS-02): a family that does not answer, in a complete sync or because
// the panel always refuses its discovery read, is never pruned on HAP or
// Matter. Split from platform-discovery-epoch.test.js (same harness).

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

const OUTPUT_SCENARIO_SENSOR_ENDPOINTS = ['light_5', 'light_6', 'cover_7', 'gate_9', 'scenario_1', 'scenario_3', 'sensor_temp_1', 'sensor_hum_1', 'sensor_light_1'];

test('COMMS-02: a discovery read the panel always refuses ends in degraded syncs that remove nothing', async (t) => {
    const { panel, hb, api, log } = await session(t);
    await waitFor(() => OUTPUT_SCENARIO_SENSOR_ENDPOINTS.every((id) => hb.endpoints.has(id)));
    const completed = syncs(log);
    panel.failReads.add('MULTI_TYPES');
    panel.dropConnections();
    // Two refused syncs reconnect; the third completes without MULTI_TYPES.
    await waitFor(() => syncs(log) === completed + 1, 20000);
    assert.equal(count(log, /refused the MULTI_TYPES read .*reconnecting/), 2);
    assert.equal(count(log, /refused the MULTI_TYPES read .* in 3 synchronizations in a row: continuing without it/), 1);
    // Three more degraded syncs (the HAP and Matter removal threshold): nothing counts as missing.
    for (let i = 0; i < 3; i += 1) {
        const n = syncs(log);
        const m = matterPasses(log);
        panel.dropConnections();
        await waitFor(() => syncs(log) === n + 1 && matterPasses(log) === m + 1, 10000);
    }
    assert.equal(count(log, /refused the MULTI_TYPES read .*reconnecting/), 2, 'degraded syncs do not reconnect');
    assert.deepEqual(hb.unregisterCalls, []);
    assert.deepEqual(api.unregistered, []);
    assert.equal(count(log, /absent for|Missing candidate/), 0);
    assert.ok(OUTPUT_SCENARIO_SENSOR_ENDPOINTS.every((id) => hb.endpoints.has(id)));
});
