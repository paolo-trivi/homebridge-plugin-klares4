const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { Lares4Platform } = require('../dist/platform/index.js');

const log = { info() {}, warn() {}, error() {}, debug() {}, success() {} };

// F43 (seen on a real bridge): partial-arm scenarios hidden by the security
// policy stayed on Matter forever as cache-restored endpoints, because the
// prune only drops cached-only endpoints that the config no longer exposes.
function clientWithScenarios(options = {}) {
    const client = new KseniaWebSocketClient('127.0.0.1', 1, false, 'hb', '0000', log, options);
    client['messageService'].handleReadResponse({
        CMD: 'READ_RES', ID: '1', PAYLOAD_TYPE: 'MULTI_TYPES',
        PAYLOAD: { SCENARIOS: [
            { ID: '3', DES: 'Inserisci Tapparelle', CAT: 'PARTIAL', PIN: 'P' },
            { ID: '5', DES: 'Chiudi Zona Giorno', CAT: 'GEN', PIN: 'N' },
            { ID: '2', DES: 'Inserisci Totale', CAT: 'ARM', PIN: 'N' },
        ] },
    });
    return client;
}

test('F43: the client reports which scenarios the arming policy suppresses', () => {
    const client = clientWithScenarios();
    assert.equal(client.isScenarioSuppressed('scenario_3'), true);
    assert.equal(client.isScenarioSuppressed('scenario_2'), true);
    assert.equal(client.isScenarioSuppressed('scenario_5'), false);
    assert.equal(client.isScenarioSuppressed('scenario_99'), false, 'unknown scenarios are left to discovery');
    assert.equal(clientWithScenarios({ exposePartialArmScenarios: true }).isScenarioSuppressed('scenario_3'), false);
});

test('F43: a suppressed scenario is not Matter-eligible, so its cached endpoint is pruned', () => {
    const platform = Object.create(Lares4Platform.prototype);
    platform.wsClient = clientWithScenarios();
    platform.discoveryService = { resolveMatterPolicy: () => ({ exposed: true }) };
    const scenario = (id) => ({ id, type: 'scenario', name: 'x', status: {} });
    assert.equal(platform['isMatterEligible'](scenario('scenario_3')), false);
    assert.equal(platform['isMatterEligible'](scenario('scenario_5')), true);
});
