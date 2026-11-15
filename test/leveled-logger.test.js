'use strict';

// TD-DOC-01, TD-DOC-03, TD-DOC-04, TD-Q-02: the configured log level really
// applies, state changes are not info lines, getters warn once, errors are
// told apart by class and always turned into text the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');

const { createLeveledLogger } = require('../dist/leveled-logger.js');
const { getEffectiveLogLevel } = require('../dist/log-levels.js');
const { toErrorMessage, KlaresError, RetryableKlaresError, ValidationKlaresError, PanelCommandRejectedError } = require('../dist/errors.js');
const { ThermostatRoutingError } = require('../dist/websocket-client/thermostat-command-id-resolver.js');
const { ThermostatAccessory } = require('../dist/accessories/thermostat-accessory.js');
const { ZoneAccessory } = require('../dist/accessories/zone-accessory.js');
const { fakeApi } = require('./fixtures/platform-session-harness.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const { Characteristic, Service } = hap;

function recorder({ withSuccess = true } = {}) {
    const lines = [];
    const at = (level) => (...args) => lines.push(`${level}| ${args.map(String).join(' ')}`);
    const log = { prefix: 'Klares4', info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
    if (withSuccess) log.success = at('success');
    return { log, lines };
}

function speak(logger) {
    logger.info('started');
    logger.success('connected');
    logger.warn('careful');
    logger.error('broken');
    logger.debug('frame', 'detail');
}

test('level 0 (minimal): only warnings and errors are written; debug lines stay at Homebridge debug level', () => {
    const { log, lines } = recorder();
    speak(createLeveledLogger(log, 0));
    assert.deepEqual(lines, ['warn| careful', 'error| broken', 'debug| frame detail']);
});

test('level 1 (normal): info lines are written, debug lines stay at Homebridge debug level', () => {
    const { log, lines } = recorder();
    speak(createLeveledLogger(log, 1));
    assert.deepEqual(lines, ['info| started', 'success| connected', 'warn| careful', 'error| broken', 'debug| frame detail']);
});

test('level 2 (debug): debug lines are written at info level, marked, without Homebridge -D', () => {
    const { log, lines } = recorder();
    speak(createLeveledLogger(log, 2));
    assert.deepEqual(lines, ['info| started', 'success| connected', 'warn| careful', 'error| broken', 'info| [debug] frame detail']);
});

test('log(level, ...) follows the same rules, the prefix is the one of Homebridge, a logger without success still gets the line', () => {
    const { log, lines } = recorder({ withSuccess: false });
    const minimal = createLeveledLogger(log, 0);
    minimal.log('info', 'dropped');
    minimal.log('warn', 'kept');
    assert.deepEqual(lines, ['warn| kept']);
    assert.equal(minimal.prefix, 'Klares4');

    lines.length = 0;
    const normal = createLeveledLogger(log, 1);
    normal.success('done');
    normal.log('debug', 'trace');
    assert.deepEqual(lines, ['info| done', 'debug| trace']);
});

test('the legacy debug switch is level 2 whatever logLevel says', () => {
    assert.equal(getEffectiveLogLevel(1, true), 2);
    assert.equal(getEffectiveLogLevel(0, true), 2);
    assert.equal(getEffectiveLogLevel(0, false), 0);
    assert.equal(getEffectiveLogLevel(undefined, false), 1);
    assert.equal(getEffectiveLogLevel(7, undefined), 1);
});

test('the platform logs through the configured level: every service it creates gets the same logger', (t) => {
    const { Lares4Platform } = require('../dist/platform/index.js');
    const build = (config) => {
        const { log, lines } = recorder();
        const api = fakeApi(tmpStorage(t, 'klares4-loglevel-'));
        const platform = new Lares4Platform(log, { platform: 'Lares4Complete', ip: '127.0.0.1', port: 9, https: false, pin: '135790', ...config }, api);
        lines.length = 0;
        return { platform, lines };
    };

    const minimal = build({ logLevel: 0 });
    minimal.platform.log.info('routine line');
    minimal.platform.log.warn('a warning');
    assert.deepEqual(minimal.lines, ['warn| a warning']);

    const debug = build({ logLevel: 1, debug: true });
    debug.platform.log.debug('a trace line');
    assert.deepEqual(debug.lines, ['info| [debug] a trace line']);
});

// ---------------------------------------------------------------- accessories

function platformAccessory(device) {
    const accessory = new hap.Accessory(device.name, hap.uuid.generate(device.id));
    return {
        UUID: accessory.UUID, displayName: device.name, context: { device },
        getService: (type) => accessory.getService(type), addService: (type) => accessory.addService(type),
    };
}

function platform() {
    const { log, lines } = recorder();
    return { Service, Characteristic, api: { hap }, config: {}, log, lines };
}

function thermostat(over = {}) {
    const status = { currentTemperature: 20, targetTemperature: 21, mode: 'heat', ...over };
    return { id: 'thermostat_18', type: 'thermostat', name: 'Thermostat', description: '', ...status, status };
}

test('a thermostat getter warns when its value goes missing, not at every read while it stays missing', async () => {
    const host = platform();
    const handler = new ThermostatAccessory(host, platformAccessory(thermostat()));
    const warnings = () => host.lines.filter((line) => line.startsWith('warn|'));

    // A status without temperatures is not pushed to HomeKit as NaN (hap-nodejs would print a warning for each).
    const printed = [];
    const original = { warn: console.warn, log: console.log, error: console.error };
    console.warn = console.log = console.error = (...args) => printed.push(args.join(' '));
    try {
        handler.updateStatus(thermostat({ currentTemperature: undefined, targetTemperature: undefined }));
    } finally {
        Object.assign(console, original);
    }
    assert.deepEqual(printed, []);
    const service = handler['service'];
    assert.equal(service.getCharacteristic(Characteristic.CurrentTemperature).value, 20);
    assert.equal(service.getCharacteristic(Characteristic.TargetTemperature).value, 21);

    for (let read = 0; read < 5; read += 1) {
        await handler.getCurrentTemperature();
        await handler.getTargetTemperature();
    }
    assert.equal(warnings().filter((line) => /Current temperature not available/.test(line)).length, 1);
    assert.equal(warnings().filter((line) => /Target temperature not available/.test(line)).length, 1);

    // The values arrive, then go missing again: that is a new event and is reported once more.
    handler.updateStatus(thermostat());
    await handler.getCurrentTemperature();
    await handler.getTargetTemperature();
    handler.updateStatus(thermostat({ currentTemperature: undefined, targetTemperature: undefined }));
    await handler.getCurrentTemperature();
    await handler.getCurrentTemperature();
    await handler.getTargetTemperature();
    assert.equal(warnings().filter((line) => /Current temperature not available/.test(line)).length, 2);
    assert.equal(warnings().filter((line) => /Target temperature not available/.test(line)).length, 2);
});

test('a zone opening and closing is a debug line, a fault is a warning: nothing at info per realtime event', () => {
    const zone = (status) => ({ id: 'zone_4', type: 'zone', name: 'Hall Door', description: '', status: { open: false, bypassed: false, armed: false, fault: false, ...status } });
    const host = platform();
    const handler = new ZoneAccessory(host, platformAccessory(zone({})));
    host.lines.length = 0;

    handler.updateStatus(zone({ open: true }));
    handler.updateStatus(zone({ open: false }));
    handler.updateStatus(zone({ fault: true }));

    assert.deepEqual(host.lines.filter((line) => line.startsWith('info|')), []);
    assert.ok(host.lines.includes('debug| Hall Door: Open'), host.lines.join('\n'));
    assert.ok(host.lines.includes('debug| Hall Door: Closed'));
    assert.ok(host.lines.includes('warn| Hall Door: Fault detected'));
});

// ---------------------------------------------------------------- errors

test('errors are told apart by class: a routing refusal is a validation refusal, a panel refusal is not', () => {
    const routing = new ThermostatRoutingError('write refused');
    assert.ok(routing instanceof ValidationKlaresError);
    assert.ok(routing instanceof KlaresError);
    assert.equal(routing.name, 'ThermostatRoutingError');

    const refused = new PanelCommandRejectedError('FAIL', 'CMD_NOT_AVAILABLE');
    assert.ok(refused instanceof KlaresError);
    assert.ok(!(refused instanceof ValidationKlaresError));
    assert.ok(!(refused instanceof RetryableKlaresError));
    assert.equal(refused.message, 'Panel rejected command: FAIL (CMD_NOT_AVAILABLE)');
    assert.equal('category' in refused, false, 'no field that nothing reads');
});

test('toErrorMessage: an AggregateError is explained by the errors it groups, an empty message by the error name', () => {
    assert.equal(toErrorMessage(new Error('boom')), 'boom');
    assert.equal(toErrorMessage('plain text'), 'plain text');
    assert.equal(toErrorMessage(undefined), 'undefined');

    const refusedV6 = Object.assign(new Error('connect ECONNREFUSED ::1:443'), { code: 'ECONNREFUSED' });
    const refusedV4 = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
    // What Node gives for a connection refused on both address families: an empty message of its own.
    assert.equal(toErrorMessage(new AggregateError([refusedV6, refusedV4], '')), 'connect ECONNREFUSED ::1:443; connect ECONNREFUSED 127.0.0.1:443');
    assert.equal(toErrorMessage(new AggregateError([new Error('same'), new Error('same')], 'All attempts failed')), 'All attempts failed; same');
    assert.equal(toErrorMessage(new AggregateError([], '')), 'AggregateError');
    assert.equal(toErrorMessage(new TypeError('')), 'TypeError');
});
