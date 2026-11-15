'use strict';

// PLAT-06: the exclude* lists accept what a user plausibly writes, never
// match by substring, never throw, and say what they discarded.

const test = require('node:test');
const assert = require('node:assert/strict');

const { DiscoveryService } = require('../dist/platform/discovery-service.js');

function collectingLog() {
    const lines = [];
    const at = (level) => (...args) => lines.push({ level, text: args.map(String).join(' ') });
    return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

const device = (id, type) => ({ id, type, name: id, description: id, status: {} });
const gate5 = device('gate_5', 'gate');
const gate1 = device('gate_1', 'gate');
const gate15 = device('gate_15', 'gate');
const light5 = device('light_5', 'light');

function service(config) {
    const log = collectingLog();
    return { discovery: new DiscoveryService(config, log), log, warnings: () => log.lines.filter((l) => l.level === 'warn') };
}

test('PLAT-06: excludeOutputs accepts numbers, strings with spaces and full IDs', () => {
    for (const entry of [5, ' 5', '5 ', 'gate_5', 'light_5', 'cover_5', ' gate_5 ', '05']) {
        const { discovery, warnings } = service({ excludeOutputs: [entry] });
        assert.equal(discovery.isDeviceExcluded(gate5), true, `${JSON.stringify(entry)} hides gate_5`);
        assert.equal(discovery.isDeviceExcluded(light5), true, 'outputs share one numeric namespace');
        assert.equal(discovery.isDeviceExcluded(gate1), false);
        assert.equal(warnings().length, 0, `${JSON.stringify(entry)} is understood, no warning`);
    }
});

test('PLAT-06: the comparison stays exact (no substring match)', () => {
    const { discovery } = service({ excludeOutputs: ['5'] });
    assert.equal(discovery.isDeviceExcluded(gate15), false);
    assert.equal(discovery.isDeviceExcluded(gate5), true);
});

test('PLAT-06: a string instead of an array excludes nothing (no substring), with a warning', () => {
    const { discovery, warnings } = service({ excludeOutputs: '15' });
    for (const g of [gate1, gate5, gate15]) assert.equal(discovery.isDeviceExcluded(g), false);
    assert.equal(warnings().length, 1);
    assert.match(warnings()[0].text, /excludeOutputs/);
    assert.match(warnings()[0].text, /string/);
});

test('PLAT-06: an object instead of an array does not throw and excludes nothing', () => {
    const { discovery, warnings } = service({ excludeOutputs: {}, excludeZones: { a: 1 }, excludeScenarios: 7, excludeSensors: true });
    assert.doesNotThrow(() => {
        discovery.isDeviceExcluded(gate5);
        discovery.shouldExcludeDevice(device('zone_1', 'zone'));
        discovery.isDeviceExcluded(device('scenario_7', 'scenario'));
        discovery.isDeviceExcluded(device('sensor_temp_1', 'sensor'));
    });
    assert.equal(warnings().length, 1);
    for (const key of ['excludeOutputs', 'excludeZones', 'excludeScenarios', 'excludeSensors']) assert.match(warnings()[0].text, new RegExp(key));
});

test('PLAT-06: entries that are not IDs of that kind are dropped and named in the warning', () => {
    const { discovery, warnings } = service({ excludeOutputs: ['abc', 'zone_3', 5, null, {}, '', 1.5, -2] });
    assert.equal(discovery.isDeviceExcluded(gate5), true, 'the valid entry still applies');
    assert.equal(warnings().length, 1);
    const text = warnings()[0].text;
    for (const quoted of ['"abc"', '"zone_3"', '1.5', '-2', '""']) assert.ok(text.includes(quoted), `${quoted} cited in: ${text}`);
});

test('PLAT-06: each list takes its own ID family', () => {
    const { discovery, warnings } = service({
        excludeZones: [' 3', 'zone_4'], excludeScenarios: ['scenario_2', 6], excludeSensors: ['sensor_temp_1', 'sensor_light_9', 12, 'sensor_system_temp_in'],
    });
    assert.equal(discovery.isDeviceExcluded(device('zone_3', 'zone')), true);
    assert.equal(discovery.isDeviceExcluded(device('zone_4', 'zone')), true);
    assert.equal(discovery.isDeviceExcluded(device('zone_5', 'zone')), false);
    assert.equal(discovery.isDeviceExcluded(device('scenario_2', 'scenario')), true);
    assert.equal(discovery.isDeviceExcluded(device('scenario_6', 'scenario')), true);
    assert.equal(discovery.isDeviceExcluded(device('scenario_3', 'scenario')), false);
    // A DOMUS sensor ID names all three of its readings, as a bare number always did.
    for (const id of ['sensor_temp_1', 'sensor_hum_1', 'sensor_light_1', 'sensor_temp_9', 'sensor_hum_12']) {
        assert.equal(discovery.isDeviceExcluded(device(id, 'sensor')), true, id);
    }
    assert.equal(discovery.isDeviceExcluded(device('sensor_temp_2', 'sensor')), false);
    // The panel's own temperature sensors are listed by full ID (current semantics).
    assert.equal(discovery.isDeviceExcluded(device('sensor_system_temp_in', 'sensor')), true);
    assert.equal(discovery.isDeviceExcluded(device('sensor_system_temp_out', 'sensor')), false);
    assert.equal(warnings().length, 0);
});

test('PLAT-06: a number family ID of another list is rejected, not reinterpreted', () => {
    const { discovery, warnings } = service({ excludeZones: ['light_5'], excludeScenarios: ['zone_1'] });
    assert.equal(discovery.isDeviceExcluded(device('zone_5', 'zone')), false);
    assert.equal(discovery.isDeviceExcluded(device('scenario_1', 'scenario')), false);
    assert.match(warnings()[0].text, /"light_5"/);
    assert.match(warnings()[0].text, /"zone_1"/);
});

test('PLAT-06: a list replaced after construction (KSA import) is read again', () => {
    const config = { excludeOutputs: ['5'] };
    const { discovery } = service(config);
    assert.equal(discovery.isDeviceExcluded(gate1), false);
    config.excludeOutputs = ['5', '1'];
    assert.equal(discovery.isDeviceExcluded(gate1), true);
    config.excludeOutputs = [' 1'];
    assert.equal(discovery.isDeviceExcluded(gate1), true);
    assert.equal(discovery.isDeviceExcluded(gate5), false);
});

test('PLAT-06: excluded devices keep the "excluded" message and a quiet check', () => {
    const { discovery, log } = service({ excludeOutputs: [5] });
    assert.equal(discovery.shouldExcludeDevice(gate5), true);
    assert.ok(log.lines.some((l) => l.level === 'debug' && /Output excluded/.test(l.text)));
});
