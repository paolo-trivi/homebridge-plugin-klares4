'use strict';

// MAT-07: two "initial sync complete" in a row (reconnect right after boot)
// must not run two finalize→prune chains at once.

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '5';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '10';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { SyncLifecycle } = require('../dist/platform/sync-lifecycle.js');
const { makeHb24MatterApi } = require('./fixtures/hb24-matter-api.js');
const { recordingLog } = require('./fixtures/lares4-mock-panel.js');
const { waitFor } = require('./fixtures/wait-for.js');

const zone = (n, name) => ({ id: `zone_${n}`, type: 'zone', name, description: '', status: { armed: false, bypassed: false, fault: false, open: false } });
const cover = (n, name) => ({ id: `cover_${n}`, type: 'cover', name, description: '', status: { position: 0, state: 'stopped' } });

function storage(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-single-flight-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

async function setup(t) {
    const hb = makeHb24MatterApi();
    const log = recordingLog();
    const registry = new MatterAccessoryRegistry({ api: hb.api, log, getWsClient: () => undefined, storagePath: storage(t) });
    const devices = [1, 2, 3].map((n) => zone(n, `Window ${n}`));
    const lifecycle = new SyncLifecycle({
        log,
        accessoryRegistry: { startDiscoveryCycle() {}, pruneStaleAccessories() {} },
        matterRegistry: registry,
        eligibleMatterDevices: () => devices,
    });
    lifecycle.startSync();
    for (const device of devices) await registry.addOrUpdateAccessory(device);
    // Covers with the same names arrive later and push the zones to a rename.
    for (const n of [1, 2, 3]) devices.push(cover(10 + n, `Window ${n}`));
    for (const device of devices.slice(3)) await registry.addOrUpdateAccessory(device);
    await waitFor(() => devices.every((d) => registry.getStatus(d.id) === 'registered'));
    return { hb, log, registry, lifecycle, devices };
}

test('MAT-07: back-to-back sync completions run finalize→prune one at a time', async (t) => {
    const { hb, registry, lifecycle, devices } = await setup(t);
    let running = 0;
    let overlap = 0;
    let finalizeRuns = 0;
    const finalize = registry.finalizeNameMap.bind(registry);
    registry.finalizeNameMap = async (list) => {
        running += 1;
        finalizeRuns += 1;
        if (running > 1) overlap += 1;
        try {
            await finalize(list);
        } finally {
            running -= 1;
        }
    };

    lifecycle.handleInitialSyncComplete();
    lifecycle.handleInitialSyncComplete();
    lifecycle.handleInitialSyncComplete();
    await waitFor(() => finalizeRuns >= 2 && running === 0);
    await waitFor(() => devices.every((d) => registry.getStatus(d.id) === 'registered'));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(overlap, 0, 'no concurrent finalize');
    assert.equal(finalizeRuns, 2, 'one run plus at most one queued');
    assert.deepEqual(hb.log.filter((l) => /already registered/.test(l)), []);
    const perUuid = new Map();
    for (const uuid of hb.unregisterCalls) perUuid.set(uuid, (perUuid.get(uuid) ?? 0) + 1);
    assert.ok([...perUuid.values()].every((n) => n === 1), JSON.stringify([...perUuid]));
});

test('MAT-07: a sync is pruned at most once, and not after a newer sync has started', async (t) => {
    const { registry, lifecycle } = await setup(t);
    let prunes = 0;
    registry.pruneStaleAccessories = async () => { prunes += 1; };
    let releaseFinalize;
    const finalize = registry.finalizeNameMap.bind(registry);
    registry.finalizeNameMap = async (list) => {
        await new Promise((resolve) => { releaseFinalize = resolve; });
        await finalize(list);
    };

    lifecycle.handleInitialSyncComplete();
    lifecycle.handleInitialSyncComplete(); // same sync completing twice: queued, but not pruned twice
    await waitFor(() => releaseFinalize);
    releaseFinalize();
    releaseFinalize = undefined;
    await waitFor(() => releaseFinalize);
    releaseFinalize();
    releaseFinalize = undefined;
    await waitFor(() => prunes === 1);

    lifecycle.startSync();
    lifecycle.handleInitialSyncComplete();
    await waitFor(() => releaseFinalize);
    lifecycle.startSync(); // reconnect while the finalize of the previous sync is in flight
    releaseFinalize();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => !lifecycle['matterRun']);
    assert.equal(prunes, 1, 'the superseded sync is not pruned');
});
