'use strict';

// The error path of the initialization opens no connection to anyone:
// no-outbound-network.test.js covers the successful session only.
// The hooks are installed before the plugin is loaded; synthetic data only.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const LOOPBACK = new Set([undefined, 'localhost', '127.0.0.1', '::1', '[::1]']);
const outbound = [];

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function recordingConnect(...args) {
    const first = args[0];
    const options = Array.isArray(first) ? first[0] : first;
    const target = typeof options === 'object' && options !== null ? options : { port: options, host: typeof args[1] === 'string' ? args[1] : undefined };
    if (target.path || LOOPBACK.has(target.host)) return originalConnect.apply(this, args);
    outbound.push(`net.connect ${target.host}:${target.port}`);
    process.nextTick(() => this.destroy(Object.assign(new Error('blocked by test'), { code: 'EHOSTUNREACH' })));
    return this;
};
const originalFetch = globalThis.fetch;
globalThis.fetch = function recordingFetch(input) {
    outbound.push(`fetch ${String(input && input.url ? input.url : input)}`);
    return Promise.reject(new Error('blocked by test'));
};
test.after(() => { net.Socket.prototype.connect = originalConnect; globalThis.fetch = originalFetch; });

const { fakeApi } = require('./fixtures/platform-session-harness.js');
const { recordingLog } = require('./fixtures/lares4-mock-panel.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');
const { waitFor } = require('./fixtures/wait-for.js');

test('an initialization that fails reports the error in the log only, with no connection to anyone', async (t) => {
    const { Lares4Platform } = require('../dist/platform/index.js');
    const api = fakeApi(tmpStorage(t, 'klares4-error-path-'));
    const log = recordingLog();
    const platform = new Lares4Platform(log, {
        platform: 'Lares4Complete', ip: '127.0.0.1', port: 9, https: false, pin: '135790', reconnectInterval: 20, heartbeatInterval: 60_000,
    }, api);
    platform['ksaImportService'].prepare = async () => { throw new Error('synthetic failure'); };
    api.emit('didFinishLaunching');
    await waitFor(() => log.lines.some((line) => line.includes('Lares4 initialization error')));
    await new Promise((resolve) => setTimeout(resolve, 100));
    api.emit('shutdown');
    assert.deepEqual(outbound, []);
});
