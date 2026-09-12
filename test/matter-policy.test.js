const test = require('node:test');
const assert = require('node:assert/strict');

const { DiscoveryService } = require('../dist/platform/discovery-service.js');

const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const light = {
  id: 'light_12',
  type: 'light',
  name: 'Studio',
  description: 'Studio',
  status: { on: false },
};

test('legacy config keeps Matter exposed and source name', () => {
  const service = new DiscoveryService({}, log);
  const policy = service.resolveMatterPolicy(light);
  assert.equal(policy.exposed, true);
  assert.equal(policy.displayName, 'Studio');
  assert.equal(policy.exposureSource, 'default');
});

test('per-device exposure overrides category exposure', () => {
  const service = new DiscoveryService({
    matterExposure: { lights: false },
    matterOverrides: { light_12: { exposed: true } },
  }, log);
  const policy = service.resolveMatterPolicy(light);
  assert.equal(policy.exposed, true);
  assert.equal(policy.exposureSource, 'device-override');
});

test('global exclusion cannot be overridden by Matter policy', () => {
  const service = new DiscoveryService({
    excludeOutputs: ['12'],
    matterOverrides: { light_12: { exposed: true } },
  }, log);
  assert.equal(service.resolveMatterPolicy(light).exposed, false);
});

test('Matter-only name wins without mutating shared custom name or source', () => {
  const service = new DiscoveryService({
    customNames: { outputs: { 12: 'Luce Studio' } },
    matterOverrides: { light_12: { name: 'Lampadario Studio' } },
  }, log);
  const source = { ...light };
  const shared = service.applyCustomName(source);
  const matter = service.applyMatterName(source);

  assert.equal(source.name, 'Studio');
  assert.equal(shared.name, 'Luce Studio');
  assert.equal(matter.name, 'Lampadario Studio');
  assert.equal(service.resolveMatterPolicy(source).names.nameSource, 'matter-override');
});
