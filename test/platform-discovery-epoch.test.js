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

async function session(t, { failReads = [], matter = true, cached = [] } = {}) {
    const panel = await startMockPanel({ data: { SCENARIOS }, failReads });
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
    const { panel, api, log, reconnect, refusedSyncs } = await session(t, { matter: false, cached: [ghost] });
    assert.equal(count(log, /Old Light — absent for 1\/3/), 1, 'boot sync: light family answered');

    // MULTI_TYPES fails: no output of this sync answered (2.2.0 removed light_8 here).
    await refusedSyncs(2);
    assert.equal(count(log, /Old Light — absent for/), 1);
    assert.ok(!api.unregistered.includes('light_8'));

    // Full syncs: the guard counts again, and removal still takes 3 answered syncs.
    const completed = syncs(log);
    panel.failReads.delete('MULTI_TYPES');
    await waitFor(() => syncs(log) === completed + 1, 15000);
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

test('refused discovery reads on reconnect remove nothing from Matter or HAP', async (t) => {
    const { hb, api, log, refusedSyncs } = await session(t);
    await waitFor(() => hb.endpoints.has('scenario_1'));
    await refusedSyncs(2);
    assert.deepEqual(hb.unregisterCalls, []);
    assert.deepEqual(api.unregistered, []);
    assert.equal(count(log, /\[Matter\] Missing (candidate|accessory)/), 0);
});

test('a reconnect with an unchanged panel removes nothing', async (t) => {
    const { hb, api, log, reconnect } = await session(t);
    for (let i = 0; i < 4; i += 1) await reconnect();
    assert.deepEqual(hb.unregisterCalls, []);
    assert.deepEqual(api.unregistered, []);
    assert.equal(count(log, /Missing (candidate|accessory)/), 0);
});

test.todo('PLAT-04 / MAT-02 (F1): matter-prune-tracker needs the per-family guard of hap-prune-policy; '
    + 'until then SyncLifecycle skips the whole Matter prune of a sync in which a known family is silent');
test.todo('MAT-02 (F1): endpoints restored from the Matter cache and never registered in this session are never '
    + 'pruned (third pass over cached, exposed, undiscovered endpoints)');
test.todo('PLAT-04 (F1): a system temperature probe reporting NA must not count as missing');
test.todo('PLAT-02 (F1): AccessoryRegistry.addAccessory leaves the handler of an accessory HAP refused '
    + '(bridge limit) in accessoryHandlers');
