const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
    MatterPruneTracker,
    MATTER_PRUNE_STALE_THRESHOLD_CYCLES,
} = require('../dist/platform/matter-prune-tracker.js');

const COUNTER_FILE = 'klares4-matter-prune.json';

function tmpStorage() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-prune-'));
}

function collectingLog() {
    const lines = { info: [], warn: [], debug: [], error: [] };
    return {
        lines,
        info: (m) => lines.info.push(String(m)),
        warn: (m) => lines.warn.push(String(m)),
        debug: (m) => lines.debug.push(String(m)),
        error: (m) => lines.error.push(String(m)),
    };
}

/**
 * Minimal MatterPruneDeps. `registered` is the set of uuids the registry holds
 * as live endpoints; `discovered` is what the current sync actually returned.
 */
function makeDeps({ registered, discovered, isDeviceExposed }) {
    const unregistered = [];
    const registrations = new Map(
        registered.map((uuid) => [uuid, {
            uuid,
            displayName: uuid,
            status: 'registered',
            // The prune guards read the device snapshot off the accessory to
            // tell "deliberately not exposed" from "missing from this sync".
            matterAccessory: {
                UUID: uuid,
                context: { device: { id: uuid, type: uuid.split('_')[0], name: uuid } },
            },
        }]),
    );
    return {
        unregistered,
        registrations,
        deps: {
            api: {
                matter: {
                    unregisterPlatformAccessories: async (_p, _pl, accessories) => {
                        for (const a of accessories) unregistered.push(a.UUID);
                    },
                },
            },
            registrations,
            activeDiscoveredUUIDs: new Set(discovered),
            cachedUUIDs: new Set(),
            cachedDevices: new Map(),
            isDeviceExposed,
            thermostatFallbackUUIDs: new Set(),
            fallbackStore: { remove: () => {} },
            thermostatEchoTracker: { clear: () => {} },
            fmtErr: (e) => String(e),
        },
    };
}

// ---------------------------------------------------------------------------
// Stale threshold
// ---------------------------------------------------------------------------

test('a genuinely absent device is unregistered only after the stale threshold', async () => {
    const tracker = new MatterPruneTracker(collectingLog());
    const all = ['cover_1', 'cover_2', 'zone_9'];

    for (let cycle = 1; cycle < MATTER_PRUNE_STALE_THRESHOLD_CYCLES; cycle++) {
        const { deps, unregistered } = makeDeps({ registered: all, discovered: ['cover_1', 'cover_2'] });
        await tracker.runPruneCycle(deps);
        assert.deepEqual(unregistered, [], `nothing may be removed on cycle ${cycle}`);
    }

    const { deps, unregistered } = makeDeps({ registered: all, discovered: ['cover_1', 'cover_2'] });
    await tracker.runPruneCycle(deps);
    assert.deepEqual(unregistered, ['zone_9'], 'removed once the threshold is crossed');
});

test('reappearing before the threshold clears the counter', async () => {
    const tracker = new MatterPruneTracker(collectingLog());
    const all = ['cover_1', 'cover_2', 'zone_9'];

    const miss = makeDeps({ registered: all, discovered: ['cover_1', 'cover_2'] });
    await tracker.runPruneCycle(miss.deps);

    const back = makeDeps({ registered: all, discovered: all });
    await tracker.runPruneCycle(back.deps);

    // Counter reset: it now needs the full threshold again from scratch.
    for (let i = 0; i < MATTER_PRUNE_STALE_THRESHOLD_CYCLES - 1; i++) {
        const { deps, unregistered } = makeDeps({ registered: all, discovered: ['cover_1', 'cover_2'] });
        await tracker.runPruneCycle(deps);
        assert.deepEqual(unregistered, []);
    }
});

// ---------------------------------------------------------------------------
// Partial-sync guards — the safety net the HAP pruner already had.
// ---------------------------------------------------------------------------

test('a sync that discovered nothing never prunes', async () => {
    const log = collectingLog();
    const tracker = new MatterPruneTracker(log);
    const all = ['cover_1', 'cover_2', 'zone_9'];

    for (let i = 0; i < MATTER_PRUNE_STALE_THRESHOLD_CYCLES + 2; i++) {
        const { deps, unregistered } = makeDeps({ registered: all, discovered: [] });
        await tracker.runPruneCycle(deps);
        assert.deepEqual(unregistered, [], 'an empty discovery is a failed sync, not an empty panel');
    }
    assert.ok(log.lines.warn.some((l) => l.includes('discovery returned no devices')));
});

test('a sync returning a small fraction of the registered endpoints never prunes', async () => {
    const log = collectingLog();
    const tracker = new MatterPruneTracker(log);
    const all = ['cover_1', 'cover_2', 'cover_3', 'zone_7', 'zone_8', 'zone_9'];

    // Every zone missing at once: 3 of 6 discovered is below the 50% floor.
    for (let i = 0; i < MATTER_PRUNE_STALE_THRESHOLD_CYCLES + 2; i++) {
        const { deps, unregistered } = makeDeps({
            registered: all,
            discovered: ['cover_1', 'cover_2'],
        });
        await tracker.runPruneCycle(deps);
        assert.deepEqual(unregistered, [], 'a partial sync must not march a whole device class to removal');
    }
    assert.ok(log.lines.warn.some((l) => l.includes('partial-sync floor')));
});

test('the partial-sync floor does not block pruning a single stale device', async () => {
    const tracker = new MatterPruneTracker(collectingLog());
    const all = ['cover_1', 'cover_2', 'cover_3', 'zone_9'];
    const present = ['cover_1', 'cover_2', 'cover_3'];

    let lastUnregistered = [];
    for (let i = 0; i < MATTER_PRUNE_STALE_THRESHOLD_CYCLES; i++) {
        const { deps, unregistered } = makeDeps({ registered: all, discovered: present });
        await tracker.runPruneCycle(deps);
        lastUnregistered = unregistered;
    }
    assert.deepEqual(lastUnregistered, ['zone_9'], 'a real single-device removal still goes through');
});

test('disabling a whole type via matterExposure still prunes it, floor notwithstanding', async () => {
    const tracker = new MatterPruneTracker(collectingLog());
    // Zones are the majority of the topology and the user has just switched
    // matterExposure.zones off. Discovery legitimately reports only the covers,
    // which is below the 50% floor — but this is a config change, not a broken
    // sync, so the cleanup must go through instead of blocking itself forever.
    const all = ['cover_1', 'cover_2', 'zone_7', 'zone_8', 'zone_9'];
    const isDeviceExposed = (device) => device.type !== 'zone';

    let lastUnregistered = [];
    for (let i = 0; i < MATTER_PRUNE_STALE_THRESHOLD_CYCLES; i++) {
        const { deps, unregistered } = makeDeps({
            registered: all,
            discovered: ['cover_1', 'cover_2'],
            isDeviceExposed,
        });
        await tracker.runPruneCycle(deps);
        lastUnregistered = unregistered;
    }
    assert.deepEqual(lastUnregistered.sort(), ['zone_7', 'zone_8', 'zone_9']);
});

test('the floor still protects exposed devices when another type is disabled', async () => {
    const log = collectingLog();
    const tracker = new MatterPruneTracker(log);
    // Zones off (expected absent), and on top of that the covers come back
    // half-empty — that part IS a partial sync and must still be caught.
    const all = ['cover_1', 'cover_2', 'cover_3', 'cover_4', 'zone_9'];
    const isDeviceExposed = (device) => device.type !== 'zone';

    for (let i = 0; i < MATTER_PRUNE_STALE_THRESHOLD_CYCLES + 1; i++) {
        const { deps, unregistered } = makeDeps({
            registered: all,
            discovered: ['cover_1'],
            isDeviceExposed,
        });
        await tracker.runPruneCycle(deps);
        assert.deepEqual(unregistered, [], 'one of four exposed covers is a partial sync');
    }
    assert.ok(log.lines.warn.some((l) => l.includes('partial-sync floor')));
});

test('an empty registry on a fresh install is not treated as a partial sync', async () => {
    const tracker = new MatterPruneTracker(collectingLog());
    const { deps, unregistered } = makeDeps({ registered: [], discovered: [] });
    await tracker.runPruneCycle(deps);
    assert.deepEqual(unregistered, []);
});

// ---------------------------------------------------------------------------
// Counter persistence
// ---------------------------------------------------------------------------

test('missing-cycle counters persist across restarts', async () => {
    const dir = tmpStorage();
    const all = ['cover_1', 'cover_2', 'zone_9'];
    const present = ['cover_1', 'cover_2'];

    const first = new MatterPruneTracker(collectingLog(), dir);
    await first.runPruneCycle(makeDeps({ registered: all, discovered: present }).deps);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, COUNTER_FILE), 'utf8'));
    assert.equal(onDisk.missing.zone_9, 1);

    // A restart must not lose the progress already made.
    const second = new MatterPruneTracker(collectingLog(), dir);
    assert.equal(
        JSON.parse(fs.readFileSync(path.join(dir, COUNTER_FILE), 'utf8')).missing.zone_9, 1,
    );

    let unregistered = [];
    for (let i = 1; i < MATTER_PRUNE_STALE_THRESHOLD_CYCLES; i++) {
        const run = makeDeps({ registered: all, discovered: present });
        await second.runPruneCycle(run.deps);
        unregistered = run.unregistered;
    }
    assert.deepEqual(unregistered, ['zone_9']);
});

test('a skipped partial-sync cycle does not advance the persisted counters', async () => {
    const dir = tmpStorage();
    const all = ['cover_1', 'cover_2', 'cover_3', 'zone_7', 'zone_8', 'zone_9'];

    const tracker = new MatterPruneTracker(collectingLog(), dir);
    await tracker.runPruneCycle(makeDeps({ registered: all, discovered: ['cover_1'] }).deps);

    assert.equal(fs.existsSync(path.join(dir, COUNTER_FILE)), false,
        'a skipped cycle must leave no counter trace at all');
});
