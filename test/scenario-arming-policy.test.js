const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { isIgnoredScenarioCategory } = require('../dist/websocket-client/device-parsers.js');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

// Synthetic MULTI_TYPES scenarios shaped like a real panel's list.
const SCENARIOS = [
    { ID: '1', DES: 'Inserimento totale', CAT: 'ARM', PIN: 'P' },
    { ID: '2', DES: 'Disinserimento', CAT: 'DISARM', PIN: 'P' },
    { ID: '3', DES: 'Inserisci perimetrali', CAT: 'PARTIAL', PIN: 'P' },
    { ID: '4', DES: 'Inserisci notte', CAT: 'partial', PIN: 'P' },
    { ID: '5', DES: 'Luci giardino', CAT: 'GEN', PIN: 'N' },
    { ID: '6', DES: 'Buonanotte' },
    { ID: '7', DES: 'Uscita notturna', CAT: 'ARM_AWAY', PIN: 'P' },
];

function createClient(options = {}) {
    const client = new KseniaWebSocketClient('127.0.0.1', 1, false, 'hb', '1234', silentLog, options);
    const discovered = [];
    const sent = [];
    client.onDeviceDiscovered = (device) => discovered.push(device.id);
    client['state'].idLogin = '7';
    client['state'].ws = { readyState: 1 };
    client['wsTransport'].send = async (_ws, raw) => {
        const message = JSON.parse(raw);
        sent.push(message);
        setImmediate(() => client['commandDispatcher'].resolvePendingCommand({
            ID: message.ID, CMD: 'CMD_USR_RES', PAYLOAD: { RESULT: 'OK' },
        }));
    };
    client['messageService'].handleReadResponse({
        CMD: 'READ_RES', ID: '10', SENDER: 'p', RECEIVER: '', TIMESTAMP: '0', CRC_16: '0x0000',
        PAYLOAD_TYPE: 'MULTI_TYPES', PAYLOAD: { RESULT: 'OK', SCENARIOS },
    });
    return { client, discovered, sent };
}

test('arming categories are recognised case-insensitively; PARTIAL is hidden by default', () => {
    for (const category of ['ARM', 'arm', 'DISARM', ' Disarm ']) {
        assert.equal(isIgnoredScenarioCategory(category), true, category);
        assert.equal(isIgnoredScenarioCategory(category, true), true, `${category} with partial exposure`);
    }
    assert.equal(isIgnoredScenarioCategory('PARTIAL'), true);
    assert.equal(isIgnoredScenarioCategory('Partial'), true);
    assert.equal(isIgnoredScenarioCategory('PARTIAL', true), false);
    assert.equal(isIgnoredScenarioCategory('GEN'), false);
    assert.equal(isIgnoredScenarioCategory(' gen '), false);
});

test('WS-02: a scenario category outside the allowlist is ignored unless the scenario is opted in', () => {
    for (const category of [undefined, '', null, 2, 'GENERIC', 'ARM_AWAY', 'ARMING', 'TOTAL', 'DIS']) {
        assert.equal(isIgnoredScenarioCategory(category), true, String(category));
        assert.equal(isIgnoredScenarioCategory(category, true), true, `${category} with partial exposure`);
        assert.equal(isIgnoredScenarioCategory(category, false, true), false, `${category} opted in`);
    }
    // No opt-in ever exposes arming scenarios; PARTIAL follows only exposePartialArmScenarios.
    assert.equal(isIgnoredScenarioCategory('ARM', true, true), true);
    assert.equal(isIgnoredScenarioCategory('DISARM', true, true), true);
    assert.equal(isIgnoredScenarioCategory('PARTIAL', false, true), true);
});

test('partial-arm scenarios are not discovered unless exposePartialArmScenarios is on', () => {
    const hidden = createClient();
    assert.deepEqual(hidden.discovered, ['scenario_5']);

    const exposed = createClient({ exposePartialArmScenarios: true });
    assert.deepEqual(exposed.discovered, ['scenario_3', 'scenario_4', 'scenario_5']);
});

test('triggerScenario refuses arming scenarios before anything is sent with the PIN', async () => {
    const { client, sent } = createClient();
    for (const id of ['scenario_1', 'scenario_2', 'scenario_3', 'scenario_4', 'scenario_6', 'scenario_7']) {
        await assert.rejects(() => client.triggerScenario(id), /refus/i, id);
    }
    assert.equal(sent.length, 0);

    await client.triggerScenario('scenario_5');
    assert.deepEqual(sent.map((m) => m.PAYLOAD.SCENARIO.ID), ['5']);
});

test('triggerScenario refuses a scenario whose category was never seen', async () => {
    const { client, sent } = createClient();
    await assert.rejects(() => client.triggerScenario('scenario_99'), /refus/i);
    assert.equal(sent.length, 0);
});

test('with exposePartialArmScenarios, PARTIAL may run but ARM/DISARM never do', async () => {
    const { client, sent } = createClient({ exposePartialArmScenarios: true });
    await client.triggerScenario('scenario_3');
    await client.triggerScenario('scenario_4');
    await assert.rejects(() => client.triggerScenario('scenario_1'), /refus/i);
    await assert.rejects(() => client.triggerScenario('scenario_2'), /refus/i);
    assert.deepEqual(sent.map((m) => m.PAYLOAD.SCENARIO.ID), ['3', '4']);
});
