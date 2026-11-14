const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { finalizeMatterNameMap } = require('../dist/platform/matter-name-finalizer.js');
const { MatterNameService } = require('../dist/platform/matter-name-service.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

function silentLog() {
    return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

// MAT-04: rename goes in place first. These tests cover the fallback, taken
// only when the endpoint does not show the new label.
function fallbackCoordinator(unregister) {
    return {
        readNodeLabel: async () => undefined,
        readUniqueId: async () => undefined,
        renameInPlace: async () => false,
        updateCachedRecord: async () => {},
        restoreUniqueId: async () => true,
        unregister,
    };
}

/**
 * Two devices both need a rename. The first one's unregister rejects — the
 * production failure mode where Homebridge throws on the `{ UUID }` stub. The
 * second must still be renamed: aborting the batch on the first error left
 * every later override unapplied (observed in 2.2.0-rc.1).
 */
test('a failing rename does not abort the rest of the batch', async (t) => {
    const storage = tmpStorage(t, 'klares4-finalizer-');
    const log = silentLog();
    const devices = [
        { id: 'zone_18', type: 'zone', name: 'Contatto Solaio' },
        { id: 'zone_27', type: 'zone', name: 'Sensore Tapparella Solaio' },
    ];

    const registrations = new Map([
        ['zone_18', {
            status: 'registered',
            registeredDisplayName: 'Finestra Solaio - Sens.',
            matterAccessory: { UUID: 'zone_18', clusters: { booleanState: {} } },
        }],
        ['zone_27', {
            status: 'registered',
            registeredDisplayName: 'Tapparella Solaio',
            matterAccessory: { UUID: 'zone_27', clusters: { booleanState: {} } },
        }],
    ]);

    const renamed = [];
    await finalizeMatterNameMap(devices, {
        topologyCoordinator: fallbackCoordinator(async (uuid) => {
            if (uuid === 'zone_18') {
                throw new TypeError("Cannot read properties of undefined (reading 'deviceType')");
            }
            return true;
        }),
        log,
        nameService: new MatterNameService(storage, log),
        registrations,
        recordMetadataChanged: () => {},
        registerRenamed: async (device) => { renamed.push(device.id); },
        fmtErr: (err) => (err instanceof Error ? err.message : String(err)),
    });

    assert.deepEqual(renamed, ['zone_27']);
    // The failed one keeps its previous registration rather than being dropped.
    assert.equal(registrations.has('zone_18'), true);
});

test('an unobservable unregister skips that device without throwing', async (t) => {
    const storage = tmpStorage(t, 'klares4-finalizer-');
    const log = silentLog();
    const devices = [{ id: 'zone_18', type: 'zone', name: 'Contatto Solaio' }];
    const registrations = new Map([
        ['zone_18', {
            status: 'registered',
            registeredDisplayName: 'Finestra Solaio - Sens.',
            matterAccessory: { UUID: 'zone_18', clusters: { booleanState: {} } },
        }],
    ]);

    const renamed = [];
    await finalizeMatterNameMap(devices, {
        topologyCoordinator: fallbackCoordinator(async () => false),
        log,
        nameService: new MatterNameService(storage, log),
        registrations,
        recordMetadataChanged: () => {},
        registerRenamed: async (device) => { renamed.push(device.id); },
        fmtErr: (err) => (err instanceof Error ? err.message : String(err)),
    });

    assert.deepEqual(renamed, []);
    assert.equal(registrations.has('zone_18'), true);
});
