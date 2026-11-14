'use strict';

// The plugin never talks to a third party (SP-02, SP-08, SP-12, SP-19, SP-21).
// Error reporting was removed in 2.3.0: loading the package and running a full
// platform session (login, discovery, realtime, shutdown) must not load any
// `@sentry/*` module and must not open a connection that is not loopback, even
// when the user's config still carries the old `telemetry` key.
//
// The hooks are installed before the plugin is required: a module loaded at
// import time, or a connection opened at any later point, is recorded.

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const net = require('node:net');
const dns = require('node:dns');
const dgram = require('node:dgram');

const LOOPBACK = new Set([undefined, 'localhost', '127.0.0.1', '::1', '[::1]']);
const FORBIDDEN_MODULE = /^(@sentry|@opentelemetry|sentry)(\/|$)/;

const outbound = [];
const forbiddenRequires = [];

const originalLoad = Module._load;
Module._load = function recordingLoad(request, ...rest) {
    if (typeof request === 'string' && FORBIDDEN_MODULE.test(request)) forbiddenRequires.push(request);
    return originalLoad.call(this, request, ...rest);
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function recordingConnect(...args) {
    const first = args[0];
    const options = Array.isArray(first) ? first[0] : first;
    const target = typeof options === 'object' && options !== null
        ? options
        : { port: options, host: typeof args[1] === 'string' ? args[1] : undefined };
    if (target.path || LOOPBACK.has(target.host)) return originalConnect.apply(this, args);
    outbound.push(`net.connect ${target.host}:${target.port}`);
    process.nextTick(() => this.destroy(Object.assign(new Error('blocked by test'), { code: 'EHOSTUNREACH' })));
    return this;
};

const originalLookup = dns.lookup;
dns.lookup = function recordingLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (LOOPBACK.has(hostname)) return originalLookup.call(dns, hostname, options, callback);
    outbound.push(`dns.lookup ${hostname}`);
    process.nextTick(() => callback(Object.assign(new Error('blocked by test'), { code: 'ENOTFOUND' })));
};

const originalSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function recordingSend(...args) {
    outbound.push('dgram.send');
    return originalSend.apply(this, args);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = function recordingFetch(input, init) {
    const url = String(input && input.url ? input.url : input);
    let host;
    try { host = new URL(url).hostname; } catch { host = url; }
    if (LOOPBACK.has(host)) return originalFetch(input, init);
    outbound.push(`fetch ${host}`);
    return Promise.reject(new Error('blocked by test'));
};

const { startMockPanel, recordingLog } = require('./fixtures/lares4-mock-panel.js');
const { fakeApi } = require('./fixtures/platform-session-harness.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');
const { waitFor } = require('./fixtures/wait-for.js');

const root = path.join(__dirname, '..');
const loadedSentryModules = () => Object.keys(require.cache).filter((file) => /[\\/]node_modules[\\/](@sentry|@opentelemetry|sentry)[\\/]/.test(file));
const lines = (log, level) => log.lines.filter((line) => line.startsWith(`[${level}]`));

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else yield full;
    }
}

test('the recording hooks see a connection that is not loopback', async () => {
    const socket = net.connect({ host: '192.0.2.1', port: 9 });
    await new Promise((resolve) => socket.once('error', resolve));
    assert.deepEqual(outbound.splice(0), ['net.connect 192.0.2.1:9']);
});

test('requiring the package loads no error-reporting module and opens no connection', () => {
    require('../dist/index.js');
    assert.deepEqual(forbiddenRequires, []);
    assert.deepEqual(loadedSentryModules(), []);
    assert.deepEqual(outbound, []);
});

test('no error-reporting dependency is declared, and nothing in src or dist names one', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies });
    assert.deepEqual(declared.filter((name) => FORBIDDEN_MODULE.test(name)), []);
    for (const directory of ['src', 'dist']) {
        const offenders = [...walk(path.join(root, directory))]
            .filter((file) => /\.(ts|js)$/.test(file))
            .filter((file) => /sentry|opentelemetry|ingest\.[a-z]+\.sentry|captureError|initTelemetry/i.test(fs.readFileSync(file, 'utf8')))
            .map((file) => path.relative(root, file));
        assert.deepEqual(offenders, [], `${directory} must not mention an error-reporting service`);
    }
});

for (const [label, extra] of [
    ['with the old telemetry key set to true', { telemetry: true }],
    ['with the old telemetry key set to a text', { telemetry: 'false' }],
    ['without the telemetry key', {}],
]) {
    test(`a full platform session ${label} stays on loopback and loads no @sentry module`, async (t) => {
        const panel = await startMockPanel();
        t.after(() => panel.close());
        // Built here, not with createPlatform: the harness always sets `telemetry`.
        const { Lares4Platform } = require('../dist/platform/index.js');
        const api = fakeApi(tmpStorage(t, 'klares4-no-network-'));
        const log = recordingLog();
        const platform = new Lares4Platform(log, {
            platform: 'Lares4Complete', ip: '127.0.0.1', port: panel.port, https: false, pin: '135790',
            reconnectInterval: 20, heartbeatInterval: 60_000, ...extra,
        }, api);
        api.emit('didFinishLaunching');
        await waitFor(() => log.lines.some((line) => line.includes('Initial synchronization completed')));
        panel.realtime({ STATUS_OUTPUTS: [{ ID: '5', STA: 'ON' }] });
        await waitFor(() => platform.wsClient.getAllDevices().some((device) => device.id === 'light_5' && device.status?.on === true));
        api.emit('shutdown');

        assert.deepEqual(outbound, [], 'no connection that is not loopback');
        assert.deepEqual(forbiddenRequires, [], 'no @sentry/@opentelemetry module requested');
        assert.deepEqual(loadedSentryModules(), [], 'no such module in the require cache');

        const notices = lines(log, 'info').filter((line) => /telemetry/.test(line));
        if ('telemetry' in extra) {
            assert.equal(notices.length, 1, 'one notice about the removed key');
            assert.match(notices[0], /error reporting was removed in 2\.3\.0; the `telemetry` key is ignored and can be deleted/);
        } else {
            assert.deepEqual(notices, []);
        }
    });
}

test('the removed telemetry key is reported once, whatever its value, and never read', () => {
    const { reportDeprecatedKeys, resolveRuntimeConfig } = require('../dist/platform/runtime-config.js');
    const record = () => { const seen = []; return { seen, info: (m) => seen.push(['info', m]), warn: (m) => seen.push(['warn', m]), error: (m) => seen.push(['error', m]), debug() {} }; };
    for (const value of [true, false, 'false', 0, null, undefined]) {
        const log = record();
        reportDeprecatedKeys({ platform: 'Lares4Complete', telemetry: value }, log);
        assert.equal(log.seen.length, 1, String(value));
        assert.equal(log.seen[0][0], 'info');
        // Resolving the config on its own (it runs again after a KSA import) neither reports nor warns about it.
        const resolveLog = record();
        resolveRuntimeConfig({ platform: 'Lares4Complete', ip: '192.0.2.10', pin: '123456', telemetry: value }, resolveLog);
        assert.deepEqual(resolveLog.seen, [], String(value));
    }
    const silent = record();
    reportDeprecatedKeys({ platform: 'Lares4Complete' }, silent);
    reportDeprecatedKeys(undefined, silent);
    assert.deepEqual(silent.seen, []);
});
