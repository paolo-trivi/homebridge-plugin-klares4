const test = require('node:test');
const assert = require('node:assert/strict');

process.env.KLARES4_MATTER_UNREGISTER_TIMEOUT_MS = '30';
const {
  MatterTopologyCoordinator,
} = require('../dist/platform/matter-topology-coordinator.js');

const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

test('serializes topology operations', async () => {
  const events = [];
  const present = new Set();
  const api = { matter: {
    registerPlatformAccessories: async (_p, _pl, accessories) => {
      events.push(`start-${accessories[0].UUID}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      present.add(accessories[0].UUID);
      events.push(`end-${accessories[0].UUID}`);
    },
    unregisterPlatformAccessories: async () => {},
    getAccessoryState: async (id) => present.has(id) ? {} : undefined,
  } };
  const coordinator = new MatterTopologyCoordinator(api, log);

  await Promise.all([
    coordinator.register({ UUID: 'a' }),
    coordinator.register({ UUID: 'b' }),
  ]);

  assert.deepEqual(events, ['start-a', 'end-a', 'start-b', 'end-b']);
});

test('unregister resolves only after local disappearance', async () => {
  const present = new Set(['a']);
  const api = { matter: {
    registerPlatformAccessories: async () => {},
    unregisterPlatformAccessories: async () => { present.delete('a'); },
    getAccessoryState: async (id) => present.has(id) ? {} : undefined,
  } };
  const coordinator = new MatterTopologyCoordinator(api, log);

  assert.equal(await coordinator.unregister('a', 'onOff'), true);
  assert.equal(coordinator.getState('a'), 'locally-published');
});

test('unregister is bounded when disappearance cannot be observed', async () => {
  const api = { matter: {
    registerPlatformAccessories: async () => {},
    unregisterPlatformAccessories: async () => {},
    getAccessoryState: async () => ({}),
  } };
  const coordinator = new MatterTopologyCoordinator(api, log);

  assert.equal(await coordinator.unregister('a', 'onOff'), false);
  assert.equal(coordinator.getState('a'), 'failed');
});

test('unregister trusts observation over a throwing API call', async () => {
  // Homebridge is handed a `{ UUID }` stub with no metadata and can throw
  // (observed in production as "Cannot read properties of undefined
  // (reading 'deviceType')") while still having removed the endpoint.
  const present = new Set(['a']);
  const api = { matter: {
    registerPlatformAccessories: async () => {},
    unregisterPlatformAccessories: async () => {
      present.delete('a');
      throw new TypeError("Cannot read properties of undefined (reading 'deviceType')");
    },
    getAccessoryState: async (id) => present.has(id) ? {} : undefined,
  } };
  const coordinator = new MatterTopologyCoordinator(api, log);

  assert.equal(await coordinator.unregister('a', 'onOff'), true);
  assert.equal(coordinator.getState('a'), 'locally-published');
});

test('a throwing unregister that leaves the endpoint present still fails', async () => {
  const api = { matter: {
    registerPlatformAccessories: async () => {},
    unregisterPlatformAccessories: async () => { throw new Error('boom'); },
    getAccessoryState: async () => ({}),
  } };
  const coordinator = new MatterTopologyCoordinator(api, log);

  assert.equal(await coordinator.unregister('a', 'onOff'), false);
  assert.equal(coordinator.getState('a'), 'failed');
});

// Homebridge 2.4.0 `MatterAPIImpl.unregisterPlatformAccessories` evaluates
// `requiresExternalBridge(accessory.deviceType)`, i.e. `deviceType.deviceType`,
// *before* emitting the removal: a bare `{ UUID }` stub throws a TypeError and
// nothing is removed. This mock reproduces that contract.
function homebridge24Api(present) {
  const received = [];
  return {
    received,
    api: { matter: {
      registerPlatformAccessories: async (_p, _pl, accessories) => {
        for (const accessory of accessories) present.add(accessory.UUID);
      },
      unregisterPlatformAccessories: async (_p, _pl, accessories) => {
        for (const accessory of accessories) {
          if (accessory.deviceType.deviceType === 'RoboticVacuumCleaner') continue;
        }
        for (const accessory of accessories) {
          received.push(accessory);
          present.delete(accessory.UUID);
        }
      },
      getAccessoryState: async (id) => present.has(id) ? {} : undefined,
    } },
  };
}

test('unregister hands Homebridge the registered accessory, not a bare UUID stub', async () => {
  const present = new Set();
  const { api, received } = homebridge24Api(present);
  const coordinator = new MatterTopologyCoordinator(api, log);
  const accessory = { UUID: 'light_1', deviceType: { deviceType: 0x0100 }, clusters: { onOff: {} } };

  await coordinator.register(accessory);
  assert.equal(await coordinator.unregister('light_1', 'onOff'), true);
  assert.equal(present.has('light_1'), false);
  assert.equal(received[0], accessory);
});

test('unregister works for an endpoint only known from the Homebridge cache', async () => {
  const present = new Set(['thermostat_18']);
  const { api } = homebridge24Api(present);
  const coordinator = new MatterTopologyCoordinator(api, log);
  // Cache-restored accessories carry `deviceType` as `{ name, code }`.
  coordinator.remember({ UUID: 'thermostat_18', deviceType: { name: 'TemperatureSensor', code: 770 } });

  assert.equal(await coordinator.unregister('thermostat_18', 'onOff'), true);
  assert.equal(present.has('thermostat_18'), false);
});
