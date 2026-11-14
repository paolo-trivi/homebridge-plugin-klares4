'use strict';

// HAP accessory registry lifecycle (F1): cache restore that never throws
// (PLAT-08), no handler for excluded or refused accessories, and the shared
// prune discipline on HAP (discovery floor, policy-hidden scenarios: PLAT-04,
// TD-T-06).

const test = require('node:test');
const assert = require('node:assert/strict');

const { AccessoryRegistry } = require('../dist/platform/accessory-registry.js');
const { discoveryFamily } = require('../dist/platform/hap-prune-policy.js');

class FakeAccessory {
    constructor(name, uuid) {
        this.displayName = name;
        this.UUID = uuid;
        this.context = {};
    }
}

const light = (n) => ({ id: `light_${n}`, type: 'light', name: `Light ${n}`, description: '', status: { on: false, dimmable: false } });
const scenario = (n) => ({ id: `scenario_${n}`, type: 'scenario', name: `Scenario ${n}`, description: '', status: { active: false } });

function harness({ excluded = [], createHandler } = {}) {
    const accessories = new Map();
    const handlers = new Map();
    const active = new Set();
    const unregistered = [];
    const warnings = [];
    const registry = new AccessoryRegistry({
        api: {
            hap: { uuid: { generate: (id) => `uuid-${id}` } },
            platformAccessory: FakeAccessory,
            registerPlatformAccessories: () => {},
            unregisterPlatformAccessories: (_p, _n, list) => unregistered.push(...list.map((a) => a.UUID)),
            updatePlatformAccessories: () => {},
        },
        log: { info() {}, warn: (...a) => warnings.push(a.join(' ')), debug() {} },
        pluginName: 'plugin',
        platformName: 'platform',
        accessories,
        accessoryHandlers: handlers,
        activeDiscoveredUUIDs: active,
        createAccessoryHandler: createHandler ?? (() => ({})),
        updateAccessoryHandler: () => undefined,
        isDeviceExcluded: (device) => excluded.includes(device.id),
    });
    const cache = (device) => {
        const accessory = new FakeAccessory(device?.name ?? 'x', `uuid-${device?.id ?? 'x'}`);
        accessory.context.device = device;
        registry.configureAccessory(accessory);
        return accessory;
    };
    const sync = (devices, context) => {
        registry.startDiscoveryCycle();
        for (const device of devices) registry.addAccessory(device);
        registry.pruneStaleAccessories(context);
    };
    return { registry, accessories, handlers, unregistered, warnings, cache, sync };
}

test('PLAT-08: a malformed cached context never throws out of configureAccessory', () => {
    const throwing = () => { throw new TypeError("Cannot read properties of undefined (reading 'open')"); };
    const h = harness({ createHandler: throwing });
    const bad = [
        { id: 'zone_1', type: 'zone', name: 'Zone' },
        { id: 'zone_2', type: 'zone', name: 'Zone', status: null },
        { id: 'zone_3', name: 'Zone', status: {} },
        { id: 'zone_4', type: 'zone', name: 'Zone', status: { open: false } },
    ];
    for (const device of bad) assert.doesNotThrow(() => h.cache(device));
    assert.equal(h.handlers.size, 0);
    assert.equal(h.accessories.size, 4, 'kept in the cache map: the discovery realigns or prunes it');
    assert.equal(h.warnings.length, 4);
    assert.match(h.warnings[3], /zone_4/);
});

test('PLAT-08: an accessory excluded in the config gets no handler from the cache, and goes at the first sync', () => {
    const h = harness({ excluded: ['light_2'] });
    h.cache(light(1));
    h.cache(light(2));
    assert.deepEqual([...h.handlers.keys()], ['uuid-light_1']);
    h.sync([light(1)]);
    assert.deepEqual(h.unregistered, ['uuid-light_2']);
});

test('PLAT-02: a register refused by HAP keeps no handler and disposes the one it built', () => {
    const disposed = [];
    const h = harness({ createHandler: (accessory) => ({ dispose: () => disposed.push(accessory.UUID) }) });
    h.registry['options'].api.registerPlatformAccessories = () => { throw new Error('Cannot Bridge more than 149 Accessories'); };
    assert.throws(() => h.registry.addAccessory(light(1)), /Cannot Bridge/);
    assert.equal(h.handlers.size, 0);
    assert.equal(h.accessories.size, 0);
    assert.deepEqual(disposed, ['uuid-light_1']);
});

test('TD-T-06: HAP counts nobody as missing in a sync below the 50% floor, at the edge it does', () => {
    const h = harness();
    const lights = Array.from({ length: 10 }, (_, i) => light(i));
    for (const device of lights) h.cache(device);
    for (let i = 0; i < 5; i += 1) h.sync(lights.slice(0, 4));
    assert.deepEqual(h.unregistered, [], '4 of 10: partial sync');
    assert.ok(h.warnings.some((w) => /discovery returned 4 of 10/.test(w)));

    for (let i = 0; i < 3; i += 1) h.sync(lights.slice(0, 5));
    assert.equal(h.unregistered.length, 5, '5 of 10 is not below the floor');
});

test('TD-T-06: a cached accessory without device context is pruned by the counter, not by the family', () => {
    const h = harness();
    h.cache(light(1));
    h.cache(light(2));
    const orphan = new FakeAccessory('Orphan', 'uuid-orphan');
    h.registry.configureAccessory(orphan);
    for (let i = 0; i < 3; i += 1) h.sync([light(1), light(2)]);
    assert.deepEqual(h.unregistered, ['uuid-orphan']);
});

test('PLAT-04 (case C): a cached scenario hidden by the policy goes at the first sync, even with no scenario on the panel', () => {
    const h = harness();
    h.cache(light(1));
    h.cache(scenario(3));
    h.sync([light(1)], { answeredFamilies: new Set(['light_']), isHiddenByPolicy: (d) => d.id === 'scenario_3' });
    assert.deepEqual(h.unregistered, ['uuid-scenario_3']);
});

test('the families that answered come from the sync, not from the HAP accessories seen', () => {
    const h = harness();
    const zone = { id: 'zone_1', type: 'zone', name: 'Zone 1', description: '', status: { open: false } };
    h.cache(zone);
    h.cache(light(1));
    h.cache(light(2));
    for (let i = 0; i < 4; i += 1) h.sync([zone, light(1)], { answeredFamilies: new Set(['zone_']) });
    assert.deepEqual(h.unregistered, [], 'the light family did not answer this sync');
    assert.equal(discoveryFamily('sensor_system_temp_out'), 'sensor_system_temp_out', 'each panel probe is its own family');
    assert.equal(discoveryFamily('sensor_temp_3'), 'sensor_temp_');
});
