'use strict';

// A complete sync in which one discovery family is silent (PLAT-04), through
// the real platform lifecycle: nothing is pruned and both HAP and Matter count
// the family as not answered. Same harness as platform-discovery-epoch.

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

const lastCount = (log, pattern) => {
    const match = log.lines.filter((line) => pattern.test(line)).at(-1)?.match(pattern);
    return match ? Number(match[1]) : undefined;
};
const PANEL_PROBES = 2;

test('a complete sync with a silent family removes nothing; HAP and Matter count it as not answered', async (t) => {
    const { panel, hb, api, log, reconnect } = await session(t);
    await waitFor(() => hb.endpoints.has('scenario_1') && hb.endpoints.has('scenario_3'));
    // MULTI_TYPES answers OK without its SCENARIOS section: that family is silent.
    panel.data = { ...panel.data, SCENARIOS: undefined };
    for (let i = 0; i < 3; i += 1) {
        await reconnect();
        await waitFor(() => lastCount(log, /\[Matter\] cycle #\d+: .*keptFamilyNotAnswered=(\d+)/) === 2);
        // HAP also keeps the two panel probes, whose discovery is not repeated on a reconnect.
        assert.equal(lastCount(log, /Accessory prune: .*keptCategoryNotAnswered=(\d+)/), 2 + PANEL_PROBES, `HAP, sync ${i + 2}`);
    }
    assert.deepEqual(hb.unregisterCalls, []);
    assert.deepEqual(api.unregistered, []);
    assert.equal(count(log, /absent for|Missing candidate/), 0);
});
