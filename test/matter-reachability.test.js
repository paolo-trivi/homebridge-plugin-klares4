const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const hap = require('@homebridge/hap-nodejs');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '5';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '10';
process.env.KLARES4_MATTER_UNREACHABLE_GRACE_MS = '40';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { Lares4Platform } = require('../dist/platform/index.js');
const { makeHb24MatterApi } = require('./fixtures/hb24-matter-api.js');

const silentLog = () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, success: () => {} });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storage = () => fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-reachable-'));

const zone = (id) => ({ id, type: 'zone', name: `Zona ${id}`, description: '', status: { armed: false, bypassed: false, fault: false, open: false } });
const reachableUpdates = (hb) => hb.updates
    .filter((u) => u.cluster === 'bridgedDeviceBasicInformation')
    .map((u) => [u.uuid, u.attributes.reachable]);

async function setup() {
    const hb = makeHb24MatterApi();
    const registry = new MatterAccessoryRegistry({ api: hb.api, log: silentLog(), getWsClient: () => undefined, storagePath: storage() });
    await registry.addOrUpdateAccessory(zone('zone_1'));
    await registry.addOrUpdateAccessory(zone('zone_2'));
    await delay(60);
    return { hb, registry };
}

test('losing the panel marks every registered endpoint unreachable once, and reconnecting restores it', async () => {
    const { hb, registry } = await setup();
    registry.setPanelReachable(false);
    registry.setPanelReachable(false);
    await delay(80);
    registry.setPanelReachable(false);
    await delay(80);
    assert.deepEqual(reachableUpdates(hb), [['zone_1', false], ['zone_2', false]]);
    assert.equal(hb.endpoints.get('zone_1').reachable, false);

    registry.setPanelReachable(true);
    registry.setPanelReachable(true);
    await delay(10);
    assert.deepEqual(reachableUpdates(hb).slice(2), [['zone_1', true], ['zone_2', true]]);
});

test('a connection blip shorter than the grace period publishes nothing', async () => {
    const { hb, registry } = await setup();
    registry.setPanelReachable(false);
    await delay(10);
    registry.setPanelReachable(true);
    await delay(80);
    assert.deepEqual(reachableUpdates(hb), []);
});

test('an endpoint registered while the panel is unreachable is marked unreachable too', async () => {
    const { hb, registry } = await setup();
    registry.setPanelReachable(false);
    await delay(80);
    await registry.addOrUpdateAccessory(zone('zone_3'));
    await delay(60);
    assert.deepEqual(reachableUpdates(hb).filter(([uuid]) => uuid === 'zone_3'), [['zone_3', false]]);
});

function closedPort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

test('the platform forwards WebSocket connect/disconnect to the Matter registry', async () => {
    const listeners = new Map();
    const api = {
        hap,
        user: { storagePath: () => storage() },
        platformAccessory: class {},
        registerPlatformAccessories() {},
        unregisterPlatformAccessories() {},
        on(event, callback) { listeners.set(event, callback); },
    };
    const platform = new Lares4Platform(silentLog(), {
        platform: 'Lares4Complete', ip: '127.0.0.1', port: await closedPort(), https: false,
        pin: '123456', telemetry: false, reconnectInterval: 60_000,
    }, api);
    const seen = [];
    platform.matterRegistry.setPanelReachable = (reachable) => seen.push(reachable);
    try {
        listeners.get('didFinishLaunching')();
        for (let i = 0; i < 100 && !platform.wsClient; i++) await delay(10);
        platform.wsClient.onDisconnected();
        platform.wsClient.onConnected();
        assert.deepEqual(seen.slice(-2), [false, true]);
    } finally {
        listeners.get('shutdown')();
    }
});
