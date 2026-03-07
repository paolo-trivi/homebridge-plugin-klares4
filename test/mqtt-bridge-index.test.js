const test = require('node:test');
const assert = require('node:assert/strict');

const { AccessoryIndexService } = require('../dist/mqtt-bridge/accessory-index-service.js');

function createLogger() {
  const warnings = [];
  return {
    warnings,
    logger: {
      info: () => undefined,
      debug: () => undefined,
      error: () => undefined,
      warn: (...args) => warnings.push(args.join(' ')),
    },
  };
}

function createLightDevice(id, name) {
  return {
    id,
    type: 'light',
    name,
    description: name,
    status: {
      on: false,
      dimmable: false,
    },
  };
}

function createPlatform(accessoryHandlers) {
  return {
    accessoryHandlers,
    config: {},
  };
}

test('MqttBridge refreshes accessory index when handlers change with same size', () => {
  const handlers = new Map();
  handlers.set('uuid-1', { device: createLightDevice('light_1', 'Luce Sala') });

  const { logger } = createLogger();
  const index = new AccessoryIndexService(createPlatform(handlers), logger);

  const firstMatch = index.findAccessoryByDevice('light', 'luce_sala');
  assert.ok(firstMatch);

  handlers.set('uuid-1', { device: createLightDevice('light_1', 'Luce Cucina') });

  const updatedMatch = index.findAccessoryByDevice('light', 'luce_cucina');
  assert.ok(updatedMatch);
});

test('MqttBridge detects ambiguous slug and avoids unsafe routing', () => {
  const handlers = new Map();
  handlers.set('uuid-1', { device: createLightDevice('light_1', 'Luce Sala') });
  handlers.set('uuid-2', { device: createLightDevice('light_2', 'Luce_Sala') });

  const { logger, warnings } = createLogger();
  const index = new AccessoryIndexService(createPlatform(handlers), logger);

  const match = index.findAccessoryByDevice('light', 'luce_sala');
  assert.equal(match, null);
  assert.ok(warnings.some((entry) => entry.includes('Ambiguous slug identifier')));
});
