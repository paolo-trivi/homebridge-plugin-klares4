'use strict';

// RC1-04: the Matter name map is finalized with the devices the panel
// reported in the sync that just completed, not with every device seen since
// Homebridge started. A device deleted on the panel stops counting as live,
// so its name reservation runs from the last time the panel listed it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { DeviceEventRouter } = require('../dist/platform/device-event-router.js');
const { SyncLifecycle } = require('../dist/platform/sync-lifecycle.js');
const { waitFor } = require('./fixtures/wait-for.js');

const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });
const zone = (n) => ({ id: `zone_${n}`, type: 'zone', name: `Finestra ${n}`, description: '', status: { open: false } });

function setup() {
    const finalized = [];
    let hold = Promise.resolve();
    const matterRegistry = {
        addOrUpdateAccessory: async () => {},
        updateAccessoryState: async () => {},
        startDiscoveryCycle() {},
        setPanelReachable() {},
        finalizeNameMap: async (devices) => {
            finalized.push(devices.map((d) => d.id).sort());
            await hold;
        },
        pruneStaleAccessories: async () => {},
    };
    const router = new DeviceEventRouter({
        log: silentLog(),
        discoveryService: {
            shouldExcludeDevice: () => false,
            isDeviceExcluded: () => false,
            applyCustomName: (d) => d,
            applyMatterName: (d) => ({ ...d }),
        },
        deviceListService: { saveDevicesList() {} },
        accessoryRegistry: { addAccessory() {}, updateAccessory() {} },
        matterRegistry,
        getMqttBridge: () => undefined,
    });
    const lifecycle = new SyncLifecycle({
        log: silentLog(),
        accessoryRegistry: { startDiscoveryCycle() {}, pruneStaleAccessories() {} },
        matterRegistry,
        eligibleMatterDevices: () => [...router.matterSnapshots],
    });
    const client = {};
    lifecycle.attach(client, router);
    return { client, finalized, holdFinalize: (promise) => { hold = promise; } };
}

test('RC1-04: a device the panel no longer lists is not finalized as live', async () => {
    const { client, finalized } = setup();

    client.onSyncStarted();
    for (const n of [1, 2, 3]) client.onDeviceDiscovered(zone(n));
    client.onInitialSyncComplete();
    await waitFor(() => finalized.length === 1);
    assert.deepEqual(finalized[0], ['zone_1', 'zone_2', 'zone_3']);

    // Reconnect: zone_2 was deleted on the panel; zone_3 only sends a status.
    client.onSyncStarted();
    client.onDeviceDiscovered(zone(1));
    client.onDeviceStatusUpdate(zone(3));
    client.onInitialSyncComplete();
    await waitFor(() => finalized.length === 2);
    assert.deepEqual(finalized[1], ['zone_1', 'zone_3']);
});

test('RC1-04: a queued name pass uses the list of its completed sync, even after a new sync has started', async () => {
    const { client, finalized, holdFinalize } = setup();
    let release;
    holdFinalize(new Promise((resolve) => { release = resolve; }));
    client.onSyncStarted();
    client.onDeviceDiscovered(zone(1));
    client.onInitialSyncComplete();          // pass 1 runs and is held
    client.onSyncStarted();
    for (const n of [1, 2]) client.onDeviceDiscovered(zone(n));
    client.onInitialSyncComplete();          // pass 2 is queued
    client.onSyncStarted();                  // a third login starts before pass 2 runs
    release();
    await waitFor(() => finalized.length === 2);
    assert.deepEqual(finalized, [['zone_1'], ['zone_1', 'zone_2']]);
});
