'use strict';

// Fail-closed exposure through the real platform lifecycle (WS-01 / PLAT-05,
// WS-02 / PLAT-01): a cached accessory of a device the exposure policy now
// hides is handled like an excluded one, on HomeKit and on Matter, and the
// per-device opt-ins (exposeOutputs, exposeScenarios) reach the client.

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '500';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '5';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '10';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');

const { startMockPanel, DEFAULT_DATA } = require('./fixtures/lares4-mock-panel.js');
const { createPlatform, PlatformAccessory } = require('./fixtures/platform-session-harness.js');
const { makeHbMatterApi, deviceTypes } = require('./fixtures/hb-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');

const GEN_OUTPUT = { ID: '12', DES: 'Door strike', CAT: 'GEN', MOD: 'M' };
const UNKNOWN_SCENARIO = { ID: '3', DES: 'Away', CAT: 'ARM_AWAY', PIN: 'P' };
const DATA = {
    OUTPUTS: [...DEFAULT_DATA.OUTPUTS, GEN_OUTPUT],
    SCENARIOS: [...DEFAULT_DATA.SCENARIOS, UNKNOWN_SCENARIO],
    STATUS_OUTPUTS: [...DEFAULT_DATA.STATUS_OUTPUTS, { ID: '12', STA: 'OFF' }],
};

const cachedScenario = { id: 'scenario_3', type: 'scenario', name: 'Away', description: '', status: { active: false } };
const cachedOutput = { id: 'light_12', type: 'light', name: 'Door strike', description: '', status: { on: false, dimmable: false } };

const synced = (log) => log.lines.some((line) => /Initial synchronization completed/.test(line));

async function boot(t, { config, cached = [], matter, matterCached = [] } = {}) {
    const panel = await startMockPanel({ data: DATA });
    t.after(() => panel.close());
    const { platform, api, log } = createPlatform(t, { port: panel.port, config, matter: matter?.api.matter });
    for (const device of cached) {
        const accessory = new PlatformAccessory(device.name, hap.uuid.generate(device.id));
        accessory.context.device = device;
        platform.configureAccessory(accessory);
    }
    for (const device of matterCached) {
        platform.configureMatterAccessory({ UUID: device.id, displayName: device.name, deviceType: deviceTypes.OnOffSwitch, context: { device } });
    }
    api.emit('didFinishLaunching');
    await waitFor(() => synced(log));
    return { panel, platform, api, log };
}

test('WS-02: a cached HomeKit accessory of a now-hidden scenario is removed at the first sync, like an excluded one', async (t) => {
    const { api, log, platform } = await boot(t, { cached: [cachedScenario] });
    await waitFor(() => api.unregistered.includes('scenario_3'));
    assert.equal(log.lines.some((line) => /Away — absent for/.test(line)), false, 'not handled as a missing device (3 syncs)');
    assert.equal(platform['discoveryService'].isDeviceExcluded(cachedScenario), true);
});

test('WS-02: on Matter a cached endpoint of a now-hidden scenario follows the exclusion policy', async (t) => {
    const matter = makeHbMatterApi({
        restored: [{ UUID: 'scenario_3', displayName: 'Away', deviceType: deviceTypes.OnOffSwitch, clusters: { onOff: { onOff: false } } }],
    });
    const { platform, log } = await boot(t, { matter, matterCached: [cachedScenario] });
    const policy = platform['discoveryService'].resolveMatterPolicy(cachedScenario);
    assert.equal(policy.exposed, false);
    assert.equal(policy.exposureSource, 'global-exclusion');
    // Like an excluded device on Matter: never registered again, counted by the 3-sync prune.
    await waitFor(() => log.lines.some((line) => /Missing candidate: Away \(scenario_3\) — absent for 1\/3/.test(line)));
    assert.equal(matter.registerCalls.some((call) => call.UUID === 'scenario_3'), false);
});

test('WS-01: a cached HomeKit accessory of a now-hidden GEN output is removed at the first sync, like an excluded one', async (t) => {
    const { api, log, platform } = await boot(t, { cached: [cachedOutput] });
    await waitFor(() => api.unregistered.includes('light_12'));
    assert.equal(log.lines.some((line) => /Door strike — absent for/.test(line)), false);
    assert.equal(platform['discoveryService'].resolveMatterPolicy(cachedOutput).exposed, false);
});

test('WS-01: with exposeOutputs the GEN output is exposed again as light_<id> and answers commands', async (t) => {
    const { api, panel, platform } = await boot(t, { config: { exposeOutputs: [{ outputId: '12', exposeAs: 'light' }] } });
    await waitFor(() => api.registered.includes('light_12'));
    await platform.wsClient.switchLight('light_12', true);
    const sent = panel.received.filter((m) => m.PAYLOAD_TYPE === 'CMD_SET_OUTPUT');
    assert.deepEqual(sent.map((m) => m.PAYLOAD.OUTPUT), [{ ID: '12', STA: 'ON' }]);
});

test('WS-02: with exposeScenarios a scenario of unknown category is exposed and runs', async (t) => {
    const { api, panel, platform } = await boot(t, { config: { exposeScenarios: [{ scenarioId: '3' }] } });
    await waitFor(() => api.registered.includes('scenario_3'));
    assert.equal(platform.wsClient.isScenarioSuppressed('scenario_3'), false);
    await platform.wsClient.triggerScenario('scenario_3');
    const sent = panel.received.filter((m) => m.PAYLOAD_TYPE === 'CMD_EXE_SCENARIO');
    assert.deepEqual(sent.map((m) => m.PAYLOAD.SCENARIO.ID), ['3']);
});

test('WS-01: a command to a hidden output is refused and nothing is sent to the panel', async (t) => {
    const { panel, platform } = await boot(t);
    await assert.rejects(() => platform.wsClient.switchLight('light_12', true));
    await assert.rejects(() => platform.wsClient.toggleGate('gate_12'));
    assert.equal(panel.received.filter((m) => m.PAYLOAD_TYPE === 'CMD_SET_OUTPUT').length, 0);
});
