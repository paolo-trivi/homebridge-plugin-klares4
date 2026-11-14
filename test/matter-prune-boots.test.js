'use strict';

// Matter lifecycle across Homebridge restarts (F1): a fresh registry per boot
// on the real Homebridge stack with its cache (MAT-02, MAT-03), orphan prune
// counters (MAT-17), timings as constructor options (TD-T-12) and the probe
// budget once register is known to be definitive (MAT-14).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { resolveMatterTimings } = require('../dist/platform/matter-registry-types.js');
const { isMatterAccessoryQueryable } = require('../dist/platform/matter-registration-recovery.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');
const { makeHbMatterApi } = require('./fixtures/hb-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const FAST = {
    registerProbeTimeoutMs: 2000, settledRegisterProbeTimeoutMs: 500, registerProbePollMs: 10,
    registerProbePollMaxMs: 50, stateBootstrapMs: 0, unreachableGraceMs: 0,
};
const recordingLog = () => {
    const lines = [];
    const at = (level) => (...args) => lines.push(`[${level}] ${args.join(' ')}`);
    return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug'), success: at('info') };
};

const D = {
    light: (n) => ({ id: `light_${n}`, type: 'light', name: `Light ${n}`, description: '', status: { on: false, dimmable: false } }),
    zone: (n) => ({ id: `zone_${n}`, type: 'zone', name: `Window ${n}`, description: '', status: { armed: false, bypassed: false, fault: false, open: false } }),
    scenario: (n) => ({ id: `scenario_${n}`, type: 'scenario', name: `Scene ${n}`, description: '', status: { active: false } }),
    cover: (n) => ({ id: `cover_${n}`, type: 'cover', name: `Shutter ${n}`, description: '', status: { position: 30, state: 'stopped' } }),
};

/** One Homebridge boot: a new registry on the restarted stack, one discovery sync, then stop. */
async function boot(session, storagePath, discovered, { timings = FAST, before } = {}) {
    const stack = await session.start();
    const log = recordingLog();
    const registry = new MatterAccessoryRegistry({ api: stack.api, log, getWsClient: () => undefined, storagePath, timings });
    for (const accessory of stack.cached()) registry.configureCachedAccessory(accessory);
    if (before) await before(registry, stack);
    registry.startDiscoveryCycle();
    for (const device of discovered) await registry.addOrUpdateAccessory(device);
    await waitFor(() => discovered.every((d) => registry.getStatus(d.id) === 'registered'), 10000);
    await registry.finalizeNameMap(discovered);
    await registry.pruneStaleAccessories();
    const onBridge = (id) => stack.record(id) !== undefined;
    return { stack, registry, log, onBridge };
}

test('MAT-02: a device deleted on the panel leaves the bridge at the third boot; one of a silent family stays', { timeout: 120000 }, async (t) => {
    const session = realMatterStackSession(t);
    const storagePath = tmpStorage(t, 'klares4-boots-');
    const all = [D.light(1), D.zone(2), D.zone(5), D.scenario(3), D.cover(4)];
    const first = await boot(session, storagePath, all);
    await first.stack.stop();

    // zone_2 and scenario_3 deleted; zone_5 still answers for the zones, no scenario is left.
    const remaining = all.filter((d) => !['zone_2', 'scenario_3'].includes(d.id));
    for (let n = 1; n <= 3; n += 1) {
        const b = await boot(session, storagePath, remaining);
        assert.equal(b.onBridge('zone_2'), n < 3, `zone_2 after missed boot ${n}`);
        assert.equal(b.onBridge('scenario_3'), true, 'the scenario family did not answer: kept');
        assert.ok(b.log.lines.some((l) => /keptFamilyNotAnswered=1/.test(l)));
        await b.stack.stop();
    }
    const last = await session.start();
    assert.deepEqual(last.cached().map((c) => c.UUID).sort(), ['cover_4', 'light_1', 'scenario_3', 'zone_5']);
});

test('MAT-03: with the panel offline since the boot, the cache-restored endpoints turn unreachable, and back', { timeout: 60000 }, async (t) => {
    const session = realMatterStackSession(t);
    const storagePath = tmpStorage(t, 'klares4-boots-');
    const devices = [D.light(1), D.zone(2)];
    const first = await boot(session, storagePath, devices);
    await first.stack.stop();

    const stack = await session.start();
    const registry = new MatterAccessoryRegistry({ api: stack.api, log: recordingLog(), getWsClient: () => undefined, storagePath, timings: FAST });
    for (const accessory of stack.cached()) registry.configureCachedAccessory(accessory);
    const reachable = async (id) => (await stack.read(id, 'bridgedDeviceBasicInformation'))?.reachable;
    assert.equal(await reachable('light_1'), true, 'Homebridge restores every endpoint as reachable');

    registry.setPanelReachable(false);
    for (const { id } of devices) {
        const deadline = Date.now() + 5000;
        while (await reachable(id) !== false && Date.now() < deadline) await stack.settle();
        assert.equal(await reachable(id), false, `${id} unreachable`);
    }
    registry.setPanelReachable(true);
    for (const { id } of devices) {
        const deadline = Date.now() + 5000;
        while (await reachable(id) !== true && Date.now() < deadline) await stack.settle();
        assert.equal(await reachable(id), true, `${id} reachable again`);
    }
});

test('MAT-17: prune counters of endpoints the plugin no longer holds are dropped', async (t) => {
    const storagePath = tmpStorage(t, 'klares4-orphans-');
    const file = path.join(storagePath, 'klares4-matter-prune.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, missing: { light_77: 1, zone_9: 2 } }));
    const hb = makeHbMatterApi({ restored: [{ UUID: 'zone_9', displayName: 'Window 9', deviceType: { name: 'ContactSensor', deviceType: 21, behaviors: { booleanState: {} } }, clusters: { booleanState: { stateValue: true } } }] });
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: recordingLog(), getWsClient: () => undefined, storagePath, timings: FAST });
    registry.configureCachedAccessory({ UUID: 'zone_9', displayName: 'Window 9', deviceType: hb.api.matter.deviceTypes.ContactSensor });
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(D.light(1));
    await waitFor(() => registry.getStatus('light_1') === 'registered');
    await registry.pruneStaleAccessories();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).missing, { zone_9: 2 }, 'zone_9 is still held (cache, no device context)');
});

test('TD-T-12: the Matter timings are constructor options; the environment is only their default', async (t) => {
    const saved = process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS;
    t.after(() => {
        if (saved === undefined) delete process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS;
        else process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = saved;
    });
    process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '60000';
    assert.equal(resolveMatterTimings().registerProbeTimeoutMs, 60000, 'read when resolved, not at import');
    assert.equal(resolveMatterTimings({ registerProbeTimeoutMs: 40 }).registerProbeTimeoutMs, 40);
    assert.equal(resolveMatterTimings({ unreachableGraceMs: -1 }, {}).unreachableGraceMs, 15000, 'invalid option: default');
    assert.equal(resolveMatterTimings({}, { KLARES4_MATTER_STATE_BOOTSTRAP_MS: 'x' }).stateBootstrapMs, 0);

    // An endpoint that never answers fails within the configured budget, whatever the environment says.
    const hb = makeHbMatterApi({ unqueryableTimes: { light_1: 10 } });
    const registry = new MatterAccessoryRegistry({
        api: hb.api, log: recordingLog(), getWsClient: () => undefined, storagePath: tmpStorage(t),
        timings: { ...FAST, registerProbeTimeoutMs: 30, settledRegisterProbeTimeoutMs: 30 },
    });
    await registry.addOrUpdateAccessory(D.light(1));
    await waitFor(() => registry.getStatus('light_1') === 'failed', 3000);
});

test('MAT-14: once register has proved definitive, an endpoint that does not answer is not polled for the full budget', async (t) => {
    const hb = makeHbMatterApi({ unqueryableTimes: { light_2: 10 } });
    const registry = new MatterAccessoryRegistry({
        api: hb.api, log: recordingLog(), getWsClient: () => undefined, storagePath: tmpStorage(t),
        timings: { ...FAST, registerProbeTimeoutMs: 20000, settledRegisterProbeTimeoutMs: 30 },
    });
    await registry.addOrUpdateAccessory(D.light(1));
    await waitFor(() => registry.getStatus('light_1') === 'registered');
    await registry.addOrUpdateAccessory(D.light(2));
    // Three probes (first register + two recoveries) of 30 ms each, not of 20 s.
    await waitFor(() => registry.getStatus('light_2') === 'failed', 3000);
});

test('MAT-14: a runtime whose register returns before the endpoint exists keeps the full probe budget', async (t) => {
    const hb = makeHbMatterApi();
    // Homebridge 2.4: the registration is emitted and the call resolves at once.
    const register = hb.api.matter.registerPlatformAccessories;
    hb.api.matter.registerPlatformAccessories = async (...args) => {
        setTimeout(() => { void register(...args); }, 150);
    };
    const registry = new MatterAccessoryRegistry({
        api: hb.api, log: recordingLog(), getWsClient: () => undefined, storagePath: tmpStorage(t),
        timings: { ...FAST, registerProbeTimeoutMs: 3000, settledRegisterProbeTimeoutMs: 30 },
    });
    await registry.addOrUpdateAccessory(D.light(1));
    await registry.addOrUpdateAccessory(D.light(2));
    await waitFor(() => registry.getStatus('light_1') === 'registered' && registry.getStatus('light_2') === 'registered', 3000);
    assert.deepEqual(hb.unregisterCalls, [], 'no recovery: the endpoints only needed time');
});

test('MAT-14: an endpoint is queryable only when every declared cluster answers', async () => {
    const reg = {
        uuid: 'light_3', displayName: 'Light 3', matterAccessory: { clusters: { onOff: {}, levelControl: {} } }, pendingStateUpdates: [],
    };
    const api = (answering) => ({ matter: { getAccessoryState: async (_uuid, cluster) => (answering.includes(cluster) ? {} : undefined) } });
    const log = recordingLog();
    assert.equal(await isMatterAccessoryQueryable(api(['onOff']), log, String, reg), false);
    assert.equal(await isMatterAccessoryQueryable(api(['onOff', 'levelControl']), log, String, reg), true);
});
