const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { finalizeMatterNameMap } = require('../dist/platform/matter-name-finalizer.js');
const { MatterNameService } = require('../dist/platform/matter-name-service.js');

function tmpStorage() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-finalizer-'));
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

function registration(device, registeredDisplayName) {
    return {
        uuid: device.id,
        displayName: registeredDisplayName,
        deviceType: device.type,
        status: 'registered',
        recoveryAttempts: 0,
        pendingStateUpdates: [],
        registeredDisplayName,
        matterAccessory: { UUID: device.id, displayName: registeredDisplayName, context: { device } },
    };
}

function makeDeps(log, registrations) {
    const renamed = [];
    const unregistered = [];
    return {
        renamed,
        unregistered,
        deps: {
            api: {
                matter: {
                    unregisterPlatformAccessories: async (_p, _pl, accessories) => {
                        for (const a of accessories) unregistered.push(a.UUID);
                    },
                },
            },
            log,
            registrations,
            recordMetadataChanged: () => {},
            registerRenamed: async (device) => { renamed.push(device.id); },
            fmtErr: (e) => String(e),
        },
    };
}

const cover = { id: 'cover_1', type: 'cover', name: 'Finestra Cucina' };
const zone = { id: 'zone_19', type: 'zone', name: 'Finestra Cucina' };

test('a device registered under a stale name is repaired even when absent from this sync', async () => {
    const log = collectingLog();
    const nameService = new MatterNameService(tmpStorage(), log);

    // The zone got registered under the clean name (it was alone at the time);
    // the cover has since claimed it. The zone is NOT in this sync's device
    // list — iterating `devices` alone would leave the duplicate in place.
    const registrations = new Map([
        [zone.id, registration(zone, 'Finestra Cucina')],
        [cover.id, registration(cover, 'Finestra Cucina - Tapp.')],
    ]);
    const { deps, renamed } = makeDeps(log, registrations);

    await finalizeMatterNameMap([cover, zone], { ...deps, nameService });

    assert.ok(renamed.includes('zone_19'), 'the stale endpoint must be re-registered under the map name');
    assert.ok(renamed.includes('cover_1'), 'the cover moves onto the clean name');
});

test('the repair uses the device snapshot on the registration when the sync omits it', async () => {
    const log = collectingLog();
    const nameService = new MatterNameService(tmpStorage(), log);
    nameService.finalize([cover, zone]);

    // Zone registered under the clean name, and this sync only reports the cover.
    const registrations = new Map([[zone.id, registration(zone, 'Finestra Cucina')]]);
    const { deps, renamed, unregistered } = makeDeps(log, registrations);

    await finalizeMatterNameMap([cover], { ...deps, nameService });

    assert.deepEqual(renamed, ['zone_19'], 'recovered from matterAccessory.context.device');
    assert.deepEqual(unregistered, ['zone_19']);
});

test('duplicate REGISTERED names are warned about, not just duplicate map names', async () => {
    const log = collectingLog();
    const nameService = new MatterNameService(tmpStorage(), log);

    // The cover holds the clean name the map agrees on, so it is left alone.
    // The zone was pushed to matter.js under that same name and is still
    // probing, so its rename is deferred — the duplicate survives this pass
    // and is live on the controller. That is precisely what must be surfaced.
    const stuckZone = registration(zone, 'Finestra Cucina');
    stuckZone.status = 'pending';
    const registrations = new Map([
        [cover.id, registration(cover, 'Finestra Cucina')],
        [zone.id, stuckZone],
    ]);

    const { deps, renamed } = makeDeps(log, registrations);
    await finalizeMatterNameMap([cover, zone], { ...deps, nameService });

    assert.deepEqual(renamed, [], 'a probing endpoint is not re-registered mid-flight');
    assert.ok(
        log.lines.warn.some((l) => l.includes('DUPLICATE registered name') && l.includes('Finestra Cucina')),
        'the guard must fire on what the controllers actually hold',
    );
    // The map itself is clean, so the map-level guard sees nothing — which is
    // exactly why the registered-name guard has to exist.
    assert.deepEqual(log.lines.warn.filter((l) => l.includes('DUPLICATE display name')), []);
});

test('no warning when every registered name is distinct', async () => {
    const log = collectingLog();
    const nameService = new MatterNameService(tmpStorage(), log);
    nameService.finalize([cover, zone]);

    const registrations = new Map([
        [cover.id, registration(cover, 'Finestra Cucina')],
        [zone.id, registration(zone, 'Finestra Cucina - Sens.')],
    ]);
    const { deps, renamed } = makeDeps(log, registrations);

    await finalizeMatterNameMap([cover, zone], { ...deps, nameService });

    assert.deepEqual(renamed, [], 'a settled topology needs no re-registration');
    assert.deepEqual(log.lines.warn.filter((l) => l.includes('DUPLICATE')), []);
});
