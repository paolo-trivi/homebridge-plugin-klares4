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
