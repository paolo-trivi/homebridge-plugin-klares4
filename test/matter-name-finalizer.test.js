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

function silentLog() {
    return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

/**
 * Two devices both need a rename. The first one's unregister rejects — the
 * production failure mode where Homebridge throws on the `{ UUID }` stub. The
 * second must still be renamed: aborting the batch on the first error left
 * every later override unapplied (observed in 2.2.0-rc.1).
 */
test('a failing rename does not abort the rest of the batch', async () => {
    const storage = tmpStorage();
    const log = silentLog();
    const devices = [
        { id: 'zone_18', type: 'zone', name: 'Contatto Studio' },
        { id: 'zone_27', type: 'zone', name: 'Sensore Tapparella Studio' },
    ];

    const registrations = new Map([
        ['zone_18', {
            status: 'registered',
            registeredDisplayName: 'Finestra Studio - Sens.',
            matterAccessory: { UUID: 'zone_18', clusters: { booleanState: {} } },
        }],
        ['zone_27', {
            status: 'registered',
            registeredDisplayName: 'Tapparella Studio',
            matterAccessory: { UUID: 'zone_27', clusters: { booleanState: {} } },
        }],
    ]);

    const renamed = [];
    await finalizeMatterNameMap(devices, {
        topologyCoordinator: {
            unregister: async (uuid) => {
                if (uuid === 'zone_18') {
                    throw new TypeError("Cannot read properties of undefined (reading 'deviceType')");
                }
                return true;
            },
        },
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

test('an unobservable unregister skips that device without throwing', async () => {
    const storage = tmpStorage();
    const log = silentLog();
    const devices = [{ id: 'zone_18', type: 'zone', name: 'Contatto Studio' }];
    const registrations = new Map([
        ['zone_18', {
            status: 'registered',
            registeredDisplayName: 'Finestra Studio - Sens.',
            matterAccessory: { UUID: 'zone_18', clusters: { booleanState: {} } },
        }],
    ]);

    const renamed = [];
    await finalizeMatterNameMap(devices, {
        topologyCoordinator: { unregister: async () => false },
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
