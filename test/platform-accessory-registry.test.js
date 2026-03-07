const test = require('node:test');
const assert = require('node:assert/strict');

const { AccessoryRegistry } = require('../dist/platform/accessory-registry.js');

class FakeAccessory {
  constructor(name, uuid) {
    this.displayName = name;
    this.UUID = uuid;
    this.context = {};
  }
}

function createRegistryHarness() {
  const accessories = new Map();
  const handlers = new Map();
  const active = new Set();
  const registered = [];
  const unregistered = [];
  const updated = [];

  const api = {
    hap: {
      uuid: {
        generate: (id) => `uuid-${id}`,
      },
    },
    platformAccessory: FakeAccessory,
    registerPlatformAccessories: (_pluginName, _platformName, list) => {
      registered.push(...list.map((a) => a.UUID));
    },
    unregisterPlatformAccessories: (_pluginName, _platformName, list) => {
      unregistered.push(...list.map((a) => a.UUID));
    },
  };

  const log = {
    info: () => undefined,
  };

  const registry = new AccessoryRegistry({
    api,
    log,
    pluginName: 'plugin',
    platformName: 'platform',
    accessories,
    accessoryHandlers: handlers,
    activeDiscoveredUUIDs: active,
    createAccessoryHandler: (_accessory, _device) => ({ id: 'handler' }),
    updateAccessoryHandler: (_handler, device) => {
      updated.push(device.id);
    },
  });

  return { registry, accessories, handlers, active, registered, unregistered, updated };
}

test('AccessoryRegistry adds new accessory and marks active uuid', () => {
  const { registry, accessories, handlers, active, registered } = createRegistryHarness();

  registry.addAccessory({ id: 'light_1', name: 'Luce', description: 'Luce', type: 'light' });

  assert.equal(accessories.has('uuid-light_1'), true);
  assert.equal(handlers.has('uuid-light_1'), true);
  assert.equal(active.has('uuid-light_1'), true);
  assert.deepEqual(registered, ['uuid-light_1']);
});

test('AccessoryRegistry restores cached accessory without re-register', () => {
  const { registry, accessories, registered } = createRegistryHarness();
  accessories.set('uuid-light_1', new FakeAccessory('Luce', 'uuid-light_1'));

  registry.addAccessory({ id: 'light_1', name: 'Luce', description: 'Luce', type: 'light' });

  assert.deepEqual(registered, []);
});

test('AccessoryRegistry updates existing handler', () => {
  const { registry, accessories, handlers, updated } = createRegistryHarness();
  accessories.set('uuid-light_1', new FakeAccessory('Luce', 'uuid-light_1'));
  handlers.set('uuid-light_1', { id: 'handler' });

  registry.updateAccessory({ id: 'light_1', name: 'Luce', description: 'Luce', type: 'light' });

  assert.deepEqual(updated, ['light_1']);
});

test('AccessoryRegistry prunes stale accessories', () => {
  const { registry, accessories, handlers, active, unregistered } = createRegistryHarness();
  accessories.set('uuid-light_1', new FakeAccessory('Luce', 'uuid-light_1'));
  accessories.set('uuid-light_2', new FakeAccessory('Luce2', 'uuid-light_2'));
  handlers.set('uuid-light_1', { id: 'handler1' });
  handlers.set('uuid-light_2', { id: 'handler2' });
  active.add('uuid-light_1');

  registry.pruneStaleAccessories();

  assert.equal(accessories.has('uuid-light_1'), true);
  assert.equal(accessories.has('uuid-light_2'), false);
  assert.deepEqual(unregistered, ['uuid-light_2']);
});
