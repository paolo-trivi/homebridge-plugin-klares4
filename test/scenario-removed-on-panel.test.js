'use strict';

// COMMS-10: a scenario deleted on the panel keeps its category in the client
// (the category map is never pruned), but after the next sync it is no longer
// a discovered device, so it cannot be run: no CMD_EXE_SCENARIO leaves.

const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { ValidationKlaresError } = require('../dist/errors.js');
const { startMockPanel, DEFAULT_DATA } = require('./fixtures/lares4-mock-panel.js');
const { waitFor } = require('./fixtures/wait-for.js');

const silent = { info() {}, warn() {}, error() {}, debug() {}, success() {} };

test('a scenario no longer listed after a resync cannot be run', async (t) => {
    const panel = await startMockPanel();
    const client = new KseniaWebSocketClient('127.0.0.1', panel.port, false, 'hb', '135790', silent, {
        commandTimeoutMs: 2000, heartbeatInterval: 60000, reconnectInterval: 1000,
    });
    let syncs = 0;
    client.onInitialSyncComplete = () => { syncs += 1; };
    t.after(async () => { client.disconnect(); await panel.close(); });
    await client.connect();
    await waitFor(() => syncs === 1);
    await client.triggerScenario('scenario_1');

    panel.data.SCENARIOS = DEFAULT_DATA.SCENARIOS.filter((s) => s.ID !== '1');
    panel.dropConnections();
    await waitFor(() => syncs === 2 && !client['state'].devices.has('scenario_1'), 10000);
    assert.equal(client['state'].scenarioCategoryById.get('1'), 'GEN', 'the stale category is still there');
    await assert.rejects(client.triggerScenario('scenario_1'), (error) => error instanceof ValidationKlaresError);
    assert.equal(panel.received.filter((m) => m.PAYLOAD_TYPE === 'CMD_EXE_SCENARIO').length, 1);
});
