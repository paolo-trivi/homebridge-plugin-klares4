'use strict';

// Matter eligibility reads the exposure policy through DiscoveryService only
// (the single source after F1/A): the result is the same as the former
// formula that also asked the client for suppressed arming scenarios.

const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { Lares4Platform } = require('../dist/platform/index.js');
const { DiscoveryService } = require('../dist/platform/discovery-service.js');
const { clientExposurePolicy } = require('../dist/platform/client-options.js');

const log = { info() {}, warn() {}, error() {}, debug() {}, success() {} };

function wiredPlatform(config) {
  const client = new KseniaWebSocketClient('127.0.0.1', 1, false, 'hb', '0000', log, { exposePartialArmScenarios: config.exposePartialArmScenarios });
  client['messageService'].handleReadResponse({
    CMD: 'READ_RES', ID: '1', PAYLOAD_TYPE: 'MULTI_TYPES',
    PAYLOAD: { SCENARIOS: [
      { ID: '2', DES: 'Arm all', CAT: 'ARM', PIN: 'N' },
      { ID: '3', DES: 'Arm part', CAT: 'PARTIAL', PIN: 'P' },
      { ID: '4', DES: 'Disarm', CAT: 'DISARM', PIN: 'N' },
      { ID: '5', DES: 'Evening', CAT: 'GEN', PIN: 'N' },
    ] },
  });
  const discovery = new DiscoveryService({ platform: 'x', ...config }, log);
  discovery.attachExposurePolicy(clientExposurePolicy(client));
  const platform = Object.create(Lares4Platform.prototype);
  platform.wsClient = client;
  platform.discoveryService = discovery;
  return { platform, client, discovery };
}

const scenario = (id) => ({ id, type: 'scenario', name: 'x', description: 'x', status: {} });

for (const config of [{}, { exposePartialArmScenarios: true }, { excludeScenarios: ['5'] }, { matterExposure: { scenarios: false } }]) {
  test(`Matter eligibility of scenarios is unchanged with one source (${JSON.stringify(config)})`, () => {
    const { platform, client, discovery } = wiredPlatform(config);
    for (const id of ['scenario_2', 'scenario_3', 'scenario_4', 'scenario_5', 'scenario_99']) {
      const former = !client.isScenarioSuppressed(id) && discovery.resolveMatterPolicy(scenario(id)).exposed;
      assert.equal(platform['isMatterEligible'](scenario(id)), former, id);
    }
  });
}
