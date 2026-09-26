const test = require('node:test');
const assert = require('node:assert/strict');

const { AccessoryRegistry } = require('../dist/platform/accessory-registry.js');
const { HAP_PRUNE_STALE_THRESHOLD_CYCLES } = require('../dist/platform/hap-prune-policy.js');

class FakeAccessory {
    constructor(name, uuid) {
        this.displayName = name;
        this.UUID = uuid;
        this.context = {};
    }
}

const devices = {
    zone_1: { id: 'zone_1', type: 'zone', name: 'Porta', description: '', status: { armed: false, bypassed: false, fault: false, open: false } },
    zone_2: { id: 'zone_2', type: 'zone', name: 'Finestra', description: '', status: { armed: false, bypassed: false, fault: false, open: false } },
    light_1: { id: 'light_1', type: 'light', name: 'Luce Sala', description: '', status: { on: false, dimmable: false } },
    light_2: { id: 'light_2', type: 'light', name: 'Luce Cucina', description: '', status: { on: false, dimmable: false } },
    cover_1: { id: 'cover_1', type: 'cover', name: 'Tapparella', description: '', status: { position: 0, state: 'stopped' } },
    scenario_1: { id: 'scenario_1', type: 'scenario', name: 'Notte', description: '', status: { active: false } },
    sensor_temp_1: { id: 'sensor_temp_1', type: 'sensor', name: 'Sala - Temperatura', description: '', status: { sensorType: 'temperature', value: 20 } },
    sensor_system_temp_in: { id: 'sensor_system_temp_in', type: 'sensor', name: 'Centrale', description: '', status: { sensorType: 'temperature', value: 25 } },
};

// One Homebridge process: the cached accessories (with their persisted context)
// survive across harness instances, like the cachedAccessories file does.
function harness({ cache = new Map(), excluded = [] } = {}) {
    const accessories = new Map();
    const handlers = new Map();
    const active = new Set();
    const unregistered = [];
    const persisted = [];
    const api = {
        hap: { uuid: { generate: (id) => `uuid-${id}` } },
        platformAccessory: FakeAccessory,
        registerPlatformAccessories: (_plugin, _platform, list) => {
            for (const accessory of list) cache.set(accessory.UUID, accessory);
        },
        unregisterPlatformAccessories: (_plugin, _platform, list) => {
            for (const accessory of list) {
                unregistered.push(accessory.UUID);
                cache.delete(accessory.UUID);
            }
        },
        updatePlatformAccessories: (list) => { persisted.push(...list.map((accessory) => accessory.UUID)); },
    };
    const registry = new AccessoryRegistry({
        api,
        log: { info() {}, warn() {}, debug() {} },
        pluginName: 'plugin',
        platformName: 'platform',
        accessories,
        accessoryHandlers: handlers,
        activeDiscoveredUUIDs: active,
        createAccessoryHandler: () => ({}),
        updateAccessoryHandler: () => undefined,
        isDeviceExcluded: (device) => excluded.includes(device.id),
    });
    for (const accessory of cache.values()) registry.configureAccessory(accessory);
    return { registry, accessories, active, unregistered, persisted, cache };
}

function seed(ids) {
    const cache = new Map();
    for (const id of ids) {
        const accessory = new FakeAccessory(devices[id].name, `uuid-${id}`);
        accessory.context.device = devices[id];
        cache.set(accessory.UUID, accessory);
    }
    return cache;
}

// One discovery sync: the devices the panel answered with, then the prune.
function sync(h, ids) {
    h.registry.startDiscoveryCycle();
    for (const id of ids) h.registry.addAccessory(devices[id]);
    h.registry.pruneStaleAccessories();
}

test('HAP prune: a sync where only zones answered never removes outputs, scenarios or sensors', () => {
    const all = ['zone_1', 'zone_2', 'light_1', 'light_2', 'cover_1', 'scenario_1', 'sensor_temp_1'];
    const h = harness({ cache: seed(all) });

    // READ MULTI_TYPES failed (or never answered) on many consecutive logins.
    for (let cycle = 0; cycle < HAP_PRUNE_STALE_THRESHOLD_CYCLES + 2; cycle += 1) {
        sync(h, ['zone_1', 'zone_2']);
    }

    assert.deepEqual(h.unregistered, []);
    assert.equal(h.accessories.size, all.length);
});

test('HAP prune: a device missing from an answered category is removed only after consecutive misses', () => {
    const h = harness({ cache: seed(['zone_1', 'light_1', 'light_2']) });

    for (let cycle = 1; cycle < HAP_PRUNE_STALE_THRESHOLD_CYCLES; cycle += 1) {
        sync(h, ['zone_1', 'light_1']);
        assert.deepEqual(h.unregistered, [], `removed after only ${cycle} missed sync(s)`);
    }
    sync(h, ['zone_1', 'light_1']);

    assert.deepEqual(h.unregistered, ['uuid-light_2']);
    assert.equal(h.accessories.has('uuid-light_1'), true);
});

test('HAP prune: the missed-sync counter survives a restart through the cached accessory context', () => {
    const cache = seed(['zone_1', 'light_1', 'light_2']);
    for (let restart = 1; restart < HAP_PRUNE_STALE_THRESHOLD_CYCLES; restart += 1) {
        const h = harness({ cache });
        sync(h, ['zone_1', 'light_1']);
        assert.deepEqual(h.unregistered, []);
        assert.ok(h.persisted.includes('uuid-light_2'), 'the counter change must be persisted');
    }

    const h = harness({ cache });
    sync(h, ['zone_1', 'light_1']);
    assert.deepEqual(h.unregistered, ['uuid-light_2']);
});

test('HAP prune: a device that comes back resets its missed-sync counter', () => {
    const h = harness({ cache: seed(['zone_1', 'light_1', 'light_2']) });

    for (let cycle = 1; cycle < HAP_PRUNE_STALE_THRESHOLD_CYCLES; cycle += 1) sync(h, ['zone_1', 'light_1']);
    sync(h, ['zone_1', 'light_1', 'light_2']);
    for (let cycle = 1; cycle < HAP_PRUNE_STALE_THRESHOLD_CYCLES; cycle += 1) sync(h, ['zone_1', 'light_1']);

    assert.deepEqual(h.unregistered, []);
    assert.equal(h.cache.get('uuid-light_2').context.missedDiscoveryCycles, HAP_PRUNE_STALE_THRESHOLD_CYCLES - 1);
});

test('HAP prune: sensors of one discovery source do not vouch for another', () => {
    // Only the panel's own temperature sensors (STATUS_SYSTEM) came back; BUS_HAS did not.
    const h = harness({ cache: seed(['zone_1', 'sensor_temp_1', 'sensor_system_temp_in']) });

    for (let cycle = 0; cycle < HAP_PRUNE_STALE_THRESHOLD_CYCLES + 1; cycle += 1) {
        sync(h, ['zone_1', 'sensor_system_temp_in']);
    }

    assert.deepEqual(h.unregistered, []);
});

test('HAP prune: a device excluded in the config is removed at the first sync', () => {
    const h = harness({ cache: seed(['zone_1', 'zone_2', 'light_1']), excluded: ['zone_2'] });

    sync(h, ['zone_1', 'light_1']);

    assert.deepEqual(h.unregistered, ['uuid-zone_2']);
});
