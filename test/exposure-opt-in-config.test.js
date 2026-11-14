'use strict';

// The two opt-in lists of the fail-closed exposure (WS-01 / PLAT-05,
// WS-02 / PLAT-01): validation, defaults, Homebridge UI round trip, client
// options, and the platform treating a hidden device as excluded.

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveRuntimeConfig, toPlatformConfig } = require('../dist/platform/runtime-config.js');
const { buildClientConnectionSettings } = require('../dist/platform/client-options.js');
const { DiscoveryService } = require('../dist/platform/discovery-service.js');
const { recordingLog } = require('./fixtures/lares4-mock-panel.js');

const base = { platform: 'Lares4Complete', ip: '192.0.2.10', pin: '1234' };

function resolve(extra) {
    const log = recordingLog();
    const runtime = resolveRuntimeConfig({ ...base, ...extra }, log);
    return { runtime, log };
}

test('opt-in lists default to empty and stay out of the client options', () => {
    const { runtime, log } = resolve({});
    assert.deepEqual(runtime.exposeOutputs, []);
    assert.deepEqual(runtime.exposeScenarios, []);
    assert.deepEqual(log.lines, []);
    const { options } = buildClientConnectionSettings(runtime, undefined);
    assert.equal('exposeOutputs' in options, false);
    assert.equal('exposeScenarios' in options, false);
});

test('exposeOutputs / exposeScenarios rows are normalized and passed to the client', () => {
    const { runtime, log } = resolve({
        exposeOutputs: [
            { outputId: '5', exposeAs: 'light' },
            { outputId: 6 },
            { outputId: ' light_07 ', exposeAs: 'Light' },
        ],
        exposeScenarios: [{ scenarioId: '4' }, { scenarioId: 'scenario_9' }, { scenarioId: 4 }],
    });
    assert.deepEqual(log.lines, []);
    assert.deepEqual(runtime.exposeOutputs, [
        { outputId: '5', exposeAs: 'light' },
        { outputId: '6', exposeAs: 'light' },
        { outputId: '7', exposeAs: 'light' },
    ]);
    assert.deepEqual(runtime.exposeScenarios, [{ scenarioId: '4' }, { scenarioId: '9' }]);

    const { options } = buildClientConnectionSettings(runtime, undefined);
    assert.deepEqual(options.exposeOutputs, runtime.exposeOutputs);
    assert.deepEqual(options.exposeScenarios, runtime.exposeScenarios);
});

test('invalid opt-in rows are dropped and reported in the startup configuration warning', () => {
    const { runtime, log } = resolve({
        exposeOutputs: [
            '5',
            { outputId: 'zone_3', exposeAs: 'light' },
            { outputId: '8', exposeAs: 'lock' },
            { outputId: '9', exposeAs: 'light' },
            { outputId: '9', exposeAs: 'light' },
        ],
        exposeScenarios: { scenarioId: '4' },
    });
    assert.deepEqual(runtime.exposeOutputs, [{ outputId: '9', exposeAs: 'light' }]);
    assert.deepEqual(runtime.exposeScenarios, []);
    const warning = log.lines.filter((line) => line.startsWith('[warn]')).join('\n');
    assert.match(warning, /exposeOutputs\[0\]: expected an object/);
    assert.match(warning, /exposeOutputs\[1\]: outputId "zone_3" is not an output ID/);
    assert.match(warning, /exposeOutputs\[2\]: exposeAs "lock" is not one of light; output 8 stays hidden/);
    assert.match(warning, /exposeOutputs\[4\]: output 9 is listed more than once/);
    assert.match(warning, /exposeScenarios: expected an array of objects, received object/);
});

test('the opt-in lists survive the platform config round trip unchanged', () => {
    const { runtime } = resolve({
        exposeOutputs: [{ outputId: '5', exposeAs: 'light' }],
        exposeScenarios: [{ scenarioId: '4' }],
    });
    const config = toPlatformConfig({ ...base }, runtime);
    assert.deepEqual(config.exposeOutputs, [{ outputId: '5', exposeAs: 'light' }]);
    assert.deepEqual(config.exposeScenarios, [{ scenarioId: '4' }]);
    const again = resolveRuntimeConfig(config, recordingLog());
    assert.deepEqual(again.exposeOutputs, runtime.exposeOutputs);
    assert.deepEqual(again.exposeScenarios, runtime.exposeScenarios);
});

test('a device hidden by the exposure policy is excluded by the platform (cached accessories of 2.2.0)', () => {
    const service = new DiscoveryService({ ...base }, recordingLog());
    const cachedLight = { id: 'light_5', type: 'light', name: 'Door strike', description: '', status: { on: false } };
    const cachedScenario = { id: 'scenario_4', type: 'scenario', name: 'Away', description: '', status: { active: false } };
    const visible = { id: 'light_1', type: 'light', name: 'Hall', description: '', status: { on: false } };

    assert.equal(service.isDeviceExcluded(cachedLight), false, 'nothing is hidden before the client reports it');

    const hidden = new Set(['light_5', 'scenario_4']);
    service.attachExposurePolicy({ isHiddenByExposurePolicy: (id) => hidden.has(id) });
    assert.equal(service.isDeviceExcluded(cachedLight), true);
    assert.equal(service.isDeviceExcluded(cachedScenario), true);
    assert.equal(service.isDeviceExcluded(visible), false);
    assert.equal(service.resolveMatterPolicy(cachedLight).exposed, false);
    assert.equal(service.resolveMatterPolicy(visible).exposed, true);
});
