'use strict';

// WS-09, PLAT-18, TD-DOC-15: the raw Homebridge config becomes the runtime
// config in one place, with one rule per type.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveRuntimeConfig, toPlatformConfig } = require('../dist/platform/runtime-config.js');
const { NUMERIC_LIMITS } = require('../dist/platform/runtime-config-limits.js');
const { buildClientConnectionSettings } = require('../dist/platform/client-options.js');
const { DiscoveryService } = require('../dist/platform/discovery-service.js');


const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8')).schema;

function collectingLog() {
    const lines = [];
    const at = (level) => (...args) => lines.push({ level, text: args.map(String).join(' ') });
    return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

function resolve(raw) {
    const log = collectingLog();
    const runtime = resolveRuntimeConfig({ platform: 'Lares4Complete', ip: '192.0.2.10', pin: '123456', ...raw }, log);
    return { runtime, log, warnings: log.lines.filter((l) => l.level === 'warn') };
}

const nested = (key, value) => {
    const parts = key.split('.');
    return parts.reduceRight((inner, part) => ({ [part]: inner }), value);
};
const read = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);

// ---------------------------------------------------------------------------
// Booleans: only a real boolean is interpreted.
// ---------------------------------------------------------------------------

const WRONG_TYPES = [['"true"', 'true'], ['"false"', 'false'], ['1', 1], ['0', 0], ['"yes"', 'yes'], ['an object', {}], ['an array', []]];

const DEFAULT_FALSE = [
    ['allowInsecureTls', (r) => r.allowInsecureTls],
    ['exposePartialArmScenarios', (r) => r.exposePartialArmScenarios],
    ['debug', (r) => r.debug],
    ['generateDebugFile', (r) => r.generateDebugFile],
    ['ksaImport.enabled', (r) => r.ksaImport.enabled],
    ['ksaImport.applyAtStartup', (r) => r.ksaImport.applyAtStartup],
    ['ksaImport.applyCustomNames', (r) => r.ksaImport.applyCustomNames],
    ['ksaImport.applyExclusionSuggestions', (r) => r.ksaImport.applyExclusionSuggestions],
    ['roomMapping.enabled', (r) => r.roomMapping.enabled],
    ['mqtt.enabled', (r) => r.mqtt.enabled],
];
const DEFAULT_TRUE = [
    ['https', (r) => r.https],
    ['domusThermostat.enabled', (r) => r.domusThermostat.enabled],
    ['ksaImport.applyDomusMappings', (r) => r.ksaImport.applyDomusMappings],
    ['ksaImport.applyRoomMapping', (r) => r.ksaImport.applyRoomMapping],
    ['mqtt.retain', (r) => r.mqtt.retain],
    ...['zones', 'sensors', 'scenarios', 'lights', 'covers', 'gates', 'thermostats']
        .map((k) => [`matterExposure.${k}`, (r) => r.matterExposure[k]]),
];

for (const [key, get] of DEFAULT_FALSE) {
    test(`booleans: ${key} (default false) is on only for true; a wrong type keeps false and warns`, () => {
        const base = key.startsWith('mqtt.') ? { mqtt: { broker: 'mqtt://localhost' } } : {};
        const on = resolve({ ...base, ...nested(key, true), ...(key.startsWith('mqtt.') ? { mqtt: { broker: 'b', enabled: true } } : {}) });
        assert.equal(get(on.runtime), true);
        assert.equal(on.warnings.length, 0);
        for (const [label, wrong] of WRONG_TYPES) {
            const mqtt = key.startsWith('mqtt.') ? { mqtt: { broker: 'b', enabled: wrong } } : {};
            const { runtime, warnings } = resolve(key.startsWith('mqtt.') ? mqtt : nested(key, wrong));
            assert.equal(get(runtime), false, `${key}=${label}`);
            assert.equal(warnings.length, 1, `${key}=${label}: one grouped warning`);
            assert.match(warnings[0].text, new RegExp(key.replace('.', '\\.')));
            assert.match(warnings[0].text, new RegExp(typeof wrong === 'string' || typeof wrong === 'number' ? typeof wrong : Array.isArray(wrong) ? 'array' : 'object'));
        }
    });
}

for (const [key, get] of DEFAULT_TRUE) {
    test(`booleans: ${key} (default true) is off only for false; a wrong type keeps true and warns`, () => {
        const wrap = (value) => (key.startsWith('mqtt.') ? { mqtt: { broker: 'b', ...nested(key.slice(5), value) } } : nested(key, value));
        assert.equal(get(resolve(wrap(false)).runtime), false);
        assert.equal(get(resolve(wrap(true)).runtime), true);
        assert.equal(get(resolve({ ...(key.startsWith('mqtt.') ? { mqtt: { broker: 'b' } } : {}) }).runtime), true);
        for (const [label, wrong] of WRONG_TYPES) {
            const { runtime, warnings } = resolve(wrap(wrong));
            assert.equal(get(runtime), true, `${key}=${label}`);
            assert.equal(warnings.length, 1);
            assert.match(warnings[0].text, new RegExp(key.split('.').pop()));
        }
    });
}

test('WS-09: allowInsecureTls "false" and "true" keep TLS verification on (invariant 8)', () => {
    for (const value of ['false', 'true', 1, 'yes']) {
        const { runtime } = resolve({ allowInsecureTls: value });
        const settings = buildClientConnectionSettings({ ...runtime, ip: '192.0.2.10', pin: '123456' }, undefined);
        assert.equal(settings.options.allowInsecureTls, false, JSON.stringify(value));
    }
    const on = resolve({ allowInsecureTls: true });
    assert.equal(on.runtime.allowInsecureTls, true);
});

test('PLAT-01: exposePartialArmScenarios "true" and 1 do not expose arming scenarios (invariant 9)', () => {
    for (const value of ['true', 1, {}, 'yes']) {
        const { runtime } = resolve({ exposePartialArmScenarios: value });
        const settings = buildClientConnectionSettings({ ...runtime, ip: '192.0.2.10', pin: '123456' }, undefined);
        assert.equal(settings.options.exposePartialArmScenarios, false);
    }
    assert.equal(resolve({ exposePartialArmScenarios: true }).runtime.exposePartialArmScenarios, true);
});

test('null and absent mean "use the default" without a warning', () => {
    const { runtime, warnings } = resolve({ https: null, allowInsecureTls: null, reconnectInterval: null, excludeZones: null });
    assert.equal(runtime.https, true);
    assert.equal(runtime.allowInsecureTls, false);
    assert.equal(runtime.reconnectInterval, 5000);
    assert.equal(warnings.length, 0);
});

// ---------------------------------------------------------------------------
// Numbers: schema limits.
// ---------------------------------------------------------------------------

const NUMBER_GETTERS = {
    port: (r) => r.port,
    logLevel: (r) => r.logLevel,
    maxSeconds: (r) => r.maxSeconds,
    reconnectInterval: (r) => r.reconnectInterval,
    heartbeatInterval: (r) => r.heartbeatInterval,
    commandTimeoutMs: (r) => r.commandTimeoutMs,
    coverStepSize: (r) => r.coverStepSize,
    scenarioAutoOffDelay: (r) => r.scenarioAutoOffDelay,
    devicesSummaryDelay: (r) => r.devicesSummaryDelay,
    matterUnregisterTimeoutMs: (r) => r.matterUnregisterTimeoutMs,
    debugCaptureDurationMs: (r) => r.debugCaptureDurationMs,
    'temperatureDefaults.target': (r) => r.temperatureDefaults.target,
    'temperatureDefaults.min': (r) => r.temperatureDefaults.min,
    'temperatureDefaults.max': (r) => r.temperatureDefaults.max,
    'temperatureDefaults.step': (r) => r.temperatureDefaults.step,
    'domusThermostat.sensorFreshnessMs': (r) => r.domusThermostat.sensorFreshnessMs,
    'mqtt.port': (r) => r.mqtt.port,
    'mqtt.qos': (r) => r.mqtt.qos,
};

const withValue = (key, value) => (key.startsWith('mqtt.')
    ? { mqtt: { broker: 'b', ...nested(key.slice(5), value) } }
    : nested(key, value));

test('numbers: the limits table covers exactly the keys checked here', () => {
    assert.deepEqual(Object.keys(NUMERIC_LIMITS).sort(), Object.keys(NUMBER_GETTERS).sort());
});

test('PLAT-18: the limits table equals config.schema.json (type, default, minimum, maximum, allowed values)', () => {
    for (const [key, spec] of Object.entries(NUMERIC_LIMITS)) {
        const property = key.split('.').reduce((node, part) => node.properties[part], schema);
        const where = `schema ${key}`;
        assert.equal(property.type, spec.integer ? 'integer' : 'number', where);
        assert.equal(property.default, spec.default, `${where} default`);
        if (spec.oneOf) {
            const allowed = property.enum ?? property.oneOf.map((entry) => entry.const);
            assert.deepEqual([...allowed].sort(), [...spec.oneOf].sort(), `${where} allowed values`);
        } else {
            assert.equal(property.minimum, spec.min, `${where} minimum`);
            assert.equal(property.maximum, spec.max, `${where} maximum`);
        }
    }
});

for (const [key, spec] of Object.entries(NUMERIC_LIMITS)) {
    test(`numbers: ${key} stays inside its limits whatever is written`, () => {
        const get = NUMBER_GETTERS[key];
        // The port resolves to 443 (https) when unset; every other key with no default stays undefined.
        const unset = key === 'port' ? 443 : spec.default;
        const expectWarning = (value, expected, label) => {
            const { runtime, warnings } = resolve(withValue(key, value));
            assert.equal(get(runtime), expected, `${key}=${label}`);
            assert.equal(warnings.length, 1, `${key}=${label} warns once`);
            assert.match(warnings[0].text, new RegExp(key.split('.').pop()));
        };

        assert.equal(get(resolve(withValue(key, undefined)).runtime), key === 'matterUnregisterTimeoutMs' ? undefined : unset);

        const valid = spec.oneOf ? spec.oneOf[0] : spec.min + (spec.integer ? 1 : 0.5);
        const ok = resolve(withValue(key, valid));
        assert.equal(get(ok.runtime), valid);
        assert.equal(ok.warnings.length, 0);

        for (const [label, value] of [['text', 'abc'], ['numeric text', '5000'], ['boolean', true], ['NaN', NaN],
            ['Infinity', Infinity], ['-Infinity', -Infinity], ['object', {}]]) {
            expectWarning(value, unset, label);
        }
        if (spec.integer) expectWarning(valid + 0.5, unset, 'fraction');

        if (spec.oneOf) {
            expectWarning(7, unset, 'not an allowed value');
            for (const allowed of spec.oneOf) assert.equal(get(resolve(withValue(key, allowed)).runtime), allowed);
        } else if (spec.outOfRange === 'default') {
            expectWarning(spec.min - 1, unset, 'below');
            expectWarning(spec.max + 1, unset, 'above');
        } else {
            expectWarning(spec.min - 1, spec.min, 'below');
            expectWarning(spec.max + 1, spec.max, 'above');
            for (const edge of [spec.min, spec.max]) {
                const r = resolve(withValue(key, edge));
                assert.equal(get(r.runtime), edge);
                assert.equal(r.warnings.length, 0);
            }
        }
    });
}

test('WS-09: reconnectInterval 0 and -5 are raised to the schema minimum, with a warning', () => {
    for (const value of [0, -5]) {
        const { runtime, warnings } = resolve({ reconnectInterval: value });
        assert.equal(runtime.reconnectInterval, 1000);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].text, /reconnectInterval/);
    }
});

test('WS-09: heartbeatInterval 0 is raised to the schema minimum', () => {
    assert.equal(resolve({ heartbeatInterval: 0 }).runtime.heartbeatInterval, 10000);
});

test('the port defaults to 443 with https and 80 without; an invalid port falls back to that', () => {
    assert.equal(resolve({}).runtime.port, 443);
    assert.equal(resolve({ https: false }).runtime.port, 80);
    assert.equal(resolve({ https: false, port: 8080 }).runtime.port, 8080);
    assert.equal(resolve({ https: false, port: 0 }).runtime.port, 80);
    assert.equal(resolve({ port: 'abc' }).runtime.port, 443);
});

test('logLevel: an explicit level wins, debug raises the default, anything else is NORMAL', () => {
    assert.equal(resolve({ logLevel: 0 }).runtime.logLevel, 0);
    assert.equal(resolve({ logLevel: 2, debug: false }).runtime.logLevel, 2);
    assert.equal(resolve({ debug: true }).runtime.logLevel, 2);
    assert.equal(resolve({ debug: true, logLevel: 1 }).runtime.logLevel, 1);
    assert.equal(resolve({ logLevel: 5 }).runtime.logLevel, 1);
});

// ---------------------------------------------------------------------------
// pin
// ---------------------------------------------------------------------------

test('pin: a string or a number becomes a string (F22), any other type is an error that never prints the value', () => {
    assert.equal(resolve({ pin: '123456' }).runtime.pin, '123456');
    assert.equal(resolve({ pin: 987654 }).runtime.pin, '987654');
    for (const bad of [{ secret: 'ZZ-PIN-VALUE' }, ['ZZ-PIN-VALUE'], true, 12.5, Number.NaN]) {
        const { runtime, log } = resolve({ pin: bad });
        assert.equal(runtime.pin, undefined);
        assert.equal(runtime.pinRejected, true);
        const errors = log.lines.filter((l) => l.level === 'error');
        assert.equal(errors.length, 1);
        assert.match(errors[0].text, /pin/);
        assert.doesNotMatch(JSON.stringify(log.lines), /ZZ-PIN-VALUE/);
    }
    assert.equal(resolve({ pin: undefined }).runtime.pinRejected, false);
});

test('validation messages never contain the PIN, the MQTT password or the panel address', () => {
    const { log } = resolve({
        ip: '203.0.113.77', pin: { v: 'PIN-SECRET-1' }, sender: 99, port: 'x',
        mqtt: { enabled: true, broker: 'mqtt://b', username: 7, password: 4242, qos: 'MQTT-SECRET-2' },
        reconnectInterval: 'IP-LIKE-203.0.113.77',
    });
    const text = JSON.stringify(log.lines);
    for (const secret of ['PIN-SECRET-1', '203.0.113.77', 'MQTT-SECRET-2', '4242']) assert.doesNotMatch(text, new RegExp(secret));
    assert.ok(log.lines.length >= 2);
});

test('warnings are emitted once, in one grouped entry, with errors apart', () => {
    const { log } = resolve({ reconnectInterval: 0, heartbeatInterval: 0, allowInsecureTls: 'false', pin: {} });
    assert.equal(log.lines.filter((l) => l.level === 'warn').length, 1);
    const group = log.lines.find((l) => l.level === 'warn').text;
    for (const key of ['reconnectInterval', 'heartbeatInterval', 'allowInsecureTls']) assert.match(group, new RegExp(key));
    assert.equal(log.lines.filter((l) => l.level === 'error').length, 1);
});

test('a hostile config object never makes the resolution throw', () => {
    const hostile = {
        platform: 'x', ip: {}, pin: [], port: [], https: [], sender: {}, debug: {}, logLevel: {}, excludeZones: 7, excludeOutputs: {}, excludeSensors: 'a',
        excludeScenarios: [null, {}, [], 'x'], matterExposure: 'no', matterOverrides: 5, matterRecoveryRequests: 'x', customNames: 3,
        temperatureDefaults: 'hot', domusThermostat: { manualPairs: 'x', manualCommandPairs: [null, 1, {}] }, ksaImport: [], mqtt: 'on', roomMapping: { rooms: [null, 'x', { roomName: 5 }] },
    };
    assert.doesNotThrow(() => resolveRuntimeConfig(hostile, collectingLog()));
    assert.doesNotThrow(() => new DiscoveryService(hostile, collectingLog()));
    assert.doesNotThrow(() => resolveRuntimeConfig(undefined, collectingLog()));
});

// ---------------------------------------------------------------------------
// Compatibility: a config that is valid for the current schema behaves as before.
// ---------------------------------------------------------------------------

function schemaDefaults(node) {
    const result = {};
    for (const [key, property] of Object.entries(node.properties ?? {})) {
        if (property.type === 'object' && property.properties) {
            const inner = schemaDefaults(property);
            if (Object.keys(inner).length > 0 || property.default !== undefined) result[key] = { ...(property.default ?? {}), ...inner };
        } else if (property.default !== undefined) {
            result[key] = JSON.parse(JSON.stringify(property.default));
        }
    }
    return result;
}

test('compatibility: the config the UI writes with every schema default yields the same options as before', () => {
    const raw = { platform: 'Lares4Complete', ip: '192.0.2.10', pin: '123456', ...schemaDefaults(schema) };
    const runtime = resolveRuntimeConfig(raw, collectingLog());
    const log = collectingLog();
    assert.deepEqual(log.lines, []);
    const settings = buildClientConnectionSettings({ ...runtime, ip: runtime.ip, pin: runtime.pin }, undefined);
    assert.deepEqual(settings, {
        ip: '192.0.2.10',
        port: 443,
        useHttps: true,
        sender: 'homebridge',
        pin: '123456',
        options: {
            debug: false,
            logLevel: 1,
            reconnectInterval: 5000,
            heartbeatInterval: 30000,
            commandTimeoutMs: 8000,
            allowInsecureTls: false,
            exposePartialArmScenarios: false,
            domusThermostat: { enabled: true, sensorFreshnessMs: 300000, manualPairs: [], manualCommandPairs: [] },
            ksaCache: undefined,
        },
    });
    assert.equal(runtime.maxSeconds, 30);
    assert.equal(runtime.coverStepSize, 5);
    assert.equal(runtime.scenarioAutoOffDelay, 500);
    assert.equal(runtime.devicesSummaryDelay, 2000);
    assert.equal(runtime.matterUnregisterTimeoutMs, 3000);
    assert.equal(runtime.debugCaptureDurationMs, 60000);
    assert.deepEqual(runtime.temperatureDefaults, { target: 21, min: 10, max: 38, step: 0.5 });
    assert.deepEqual(runtime.exclusions, { excludeZones: [], excludeOutputs: [], excludeSensors: [], excludeScenarios: [] });
    assert.ok(Object.values(runtime.matterExposure).every((v) => v === true));
    assert.deepEqual(runtime.ksaImport, {
        enabled: false, applyAtStartup: false, applyDomusMappings: true, applyRoomMapping: true,
        applyCustomNames: false, applyExclusionSuggestions: false,
    });
    assert.deepEqual(runtime.roomMapping, { enabled: false, rooms: [] });
    assert.equal(runtime.mqtt.enabled, false);
    assert.equal(runtime.mqtt.topicPrefix, 'homebridge/klares4');
    assert.equal(runtime.mqtt.qos, 1);
    assert.equal(runtime.mqtt.retain, true);
});

test('compatibility: a full, valid, non-default config is carried over untouched', () => {
    const raw = {
        platform: 'Lares4Complete', name: 'Home', ip: '192.0.2.10', port: 8443, https: false, sender: 'my-bridge', pin: '4321', debug: true, logLevel: 0,
        maxSeconds: 60, reconnectInterval: 2500, heartbeatInterval: 45000, commandTimeoutMs: 12000, allowInsecureTls: true,
        excludeZones: ['3'], excludeOutputs: ['5', '6'], excludeSensors: ['7', 'sensor_system_temp_in'], excludeScenarios: ['2'],
        exposePartialArmScenarios: true, matterExposure: { zones: false, lights: true, thermostats: false },
        matterOverrides: [{ deviceId: 'zone_18', name: 'Study contact', exposed: false }],
        matterRecoveryRequests: [{ deviceId: 'thermostat_18', generation: 2 }], matterUnregisterTimeoutMs: 9000,
        customNames: [{ deviceId: 'light_5', name: 'Lamp' }], scenarioAutoOffDelay: 800, coverStepSize: 10,
        temperatureDefaults: { target: 20, min: 12, max: 30, step: 1 }, devicesSummaryDelay: 4000,
        mqtt: { enabled: true, broker: 'mqtt://broker.example', port: 1884, username: 'u', password: 'p', clientId: 'c', topicPrefix: 'home/k', qos: 2, retain: false, commands: false },
        roomMapping: { enabled: true, rooms: [{ roomName: 'study', devices: [{ deviceId: 'light_5', deviceName: 'Lamp' }] }] },
        domusThermostat: { enabled: false, sensorFreshnessMs: 60000, manualPairs: [{ thermostatOutputId: '18', domusSensorId: '3' }],
            manualCommandPairs: [{ thermostatOutputId: 'thermostat_18', commandThermostatId: '2' }] },
        ksaImport: { enabled: true, filePath: '/data/backup.ksa', applyAtStartup: true, applyDomusMappings: false, applyRoomMapping: false, applyCustomNames: true, applyExclusionSuggestions: true },
        generateDebugFile: true, debugCaptureDurationMs: 600000, telemetry: false,
    };
    const log = collectingLog();
    const runtime = resolveRuntimeConfig(raw, log);
    assert.deepEqual(log.lines, [], 'a valid config produces no message');
    const view = toPlatformConfig(raw, runtime);
    assert.equal(view.telemetry, false, 'the telemetry key is left as it is');
    assert.equal(view.name, 'Home');
    const expected = { ...raw };
    delete expected.matterOverrides; delete expected.matterRecoveryRequests; delete expected.customNames;
    delete expected.logLevel; delete expected.debug; delete expected.matterExposure;
    for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(view[key], value, key);
    }
    assert.equal(view.logLevel, 0);
    assert.equal(view.debug, true);
    assert.deepEqual(view.matterOverrides, [{ deviceId: 'zone_18', name: 'Study contact', exposed: false }]);
    assert.deepEqual(view.matterRecoveryRequests, [{ deviceId: 'thermostat_18', generation: 2 }]);
    assert.deepEqual(view.customNames, [{ deviceId: 'light_5', name: 'Lamp' }]);
    assert.deepEqual(view.matterExposure, { zones: false, lights: true, thermostats: false });
    assert.deepEqual(runtime.matterExposure, { zones: false, sensors: true, scenarios: true, lights: true, covers: true, gates: true, thermostats: false });
    assert.equal(runtime.ip, '192.0.2.10');
    assert.equal(raw.matterOverrides.length, 1, 'the Homebridge config object is not modified');
});

test('the platform view is stable: resolving it again changes nothing and reports nothing', () => {
    const raw = {
        platform: 'x', ip: '192.0.2.10', pin: 1234, excludeOutputs: [5, ' 6', 'gate_7'], customNames: { outputs: { 5: ' Lamp ' } },
        matterOverrides: { zone_1: { exposed: false } }, reconnectInterval: 0, mqtt: { enabled: true, broker: 'mqtt://b' },
    };
    const first = resolveRuntimeConfig(raw, collectingLog());
    const view = toPlatformConfig(raw, first);
    const log = collectingLog();
    const second = resolveRuntimeConfig(view, log);
    assert.deepEqual(log.lines, []);
    assert.deepEqual(second, first);
});
