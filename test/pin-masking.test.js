const test = require('node:test');
const assert = require('node:assert/strict');

const { maskSensitiveData } = require('../dist/log-levels.js');
const { captureRawMessage } = require('../dist/debug-capture/raw-message-capture.js');

// Synthetic PIN, never a real one.
const LOGIN_NUMERIC = '{"SENDER":"hb","CMD":"LOGIN","ID":"1","PAYLOAD_TYPE":"UNKNOWN","PAYLOAD":{"PIN":987654},"CRC_16":"0x0000"}';

test('F22: a numeric PIN is masked in log lines', () => {
    const masked = maskSensitiveData(`Sending: ${LOGIN_NUMERIC}`);
    assert.ok(!masked.includes('987654'), masked);
    assert.match(masked, /"PIN":"\*\*\*"/);
});

test('F22: a string PIN is still masked in log lines', () => {
    const masked = maskSensitiveData('{"PAYLOAD":{"PIN":"987654"}}');
    assert.ok(!masked.includes('987654'));
});

test('F22: a numeric PIN is masked in the debug capture', () => {
    const captured = captureRawMessage('out', LOGIN_NUMERIC);
    assert.ok(!captured.rawData.includes('987654'), captured.rawData);
    assert.ok(!JSON.stringify(captured.parsed).includes('987654'));
});

test('F22: the platform hands a numeric config PIN to every consumer as a string', () => {
    const { Lares4Platform } = require('../dist/platform/index.js');
    const api = {
        hap: { uuid: { generate: (s) => s }, Service: {}, Characteristic: {} },
        on: () => undefined,
        user: { storagePath: () => require('node:os').tmpdir() },
        platformAccessory: function () {},
    };
    const log = { info() {}, warn() {}, error() {}, debug() {}, success() {} };
    const platform = new Lares4Platform(log, { platform: 'Lares4Complete', name: 'K', ip: '192.0.2.1', pin: 987654, telemetry: false }, api);
    assert.equal(platform.config.pin, '987654');
});
