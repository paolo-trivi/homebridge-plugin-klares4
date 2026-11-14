'use strict';

// Telemetry as wired by the platform (TD-T-07; mutations M31, M33, M55).
// Self-contained on purpose: the telemetry module is being removed (task I),
// and this file goes with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const hap = require('@homebridge/hap-nodejs');
const { WebSocketServer } = require('ws');

const { Lares4Platform } = require('../dist/platform/index.js');
const telemetry = require('../dist/telemetry.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');
const { createSelfSignedCertificate } = require('./fixtures/self-signed-cert.js');

const silent = { info() {}, warn() {}, error() {}, debug() {}, success() {} };

function captureTransport() {
    const envelopes = [];
    telemetry._setTransportForTesting(() => ({ send: async (e) => { envelopes.push(e); return { statusCode: 200 }; }, flush: async () => true }));
    const events = () => envelopes.flatMap(([, items]) => items).filter(([h]) => h.type === 'event').map(([, p]) => p);
    return { events };
}

function fakeApi(t) {
    const listeners = new Map();
    const storagePath = tmpStorage(t, 'klares4-telemetry-');
    return {
        listeners,
        api: {
            hap, user: { storagePath: () => storagePath }, platformAccessory: class {},
            registerPlatformAccessories() {}, unregisterPlatformAccessories() {}, updatePlatformAccessories() {},
            on(e, cb) { listeners.set(e, cb); },
        },
    };
}

test('telemetry is on unless telemetry:false (documented opt-out default)', async (t) => {
    telemetry._resetForTesting();
    t.after(() => telemetry._resetForTesting());
    const { events } = captureTransport();
    telemetry.initTelemetry(undefined, '0.0.0-test');
    telemetry.captureError(new Error('default-on probe'));
    await telemetry.closeTelemetry();
    assert.equal(events().length, 1);
});

test('with telemetry on, the platform scrubs its own host, PIN and sender', { timeout: 15000 }, async (t) => {
    telemetry._resetForTesting();
    t.after(() => telemetry._resetForTesting());
    const { events } = captureTransport();
    const { api } = fakeApi(t);
    new Lares4Platform(silent, { platform: 'Lares4Complete', ip: 'pannello-finto.invalid', port: 1, https: false, pin: 135790, sender: 'mittente-finto', telemetry: true }, api);
    telemetry.captureError(new Error('boom pannello-finto.invalid 135790 mittente-finto'));
    await telemetry.closeTelemetry();
    const text = JSON.stringify(events());
    assert.equal(events().length, 1);
    for (const secret of ['pannello-finto.invalid', '135790', 'mittente-finto']) assert.ok(!text.includes(secret), `leaked ${secret}`);
});

test('a TLS setup failure that allowInsecureTls would fix is not reported to telemetry', { timeout: 15000 }, async (t) => {
    const server = https.createServer(createSelfSignedCertificate());
    const wss = new WebSocketServer({ server });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { for (const c of wss.clients) c.terminate(); wss.close(() => server.close(resolve)); }));
    telemetry._resetForTesting();
    t.after(() => telemetry._resetForTesting());
    const { events } = captureTransport();
    const errors = [];
    const { api, listeners } = fakeApi(t);
    new Lares4Platform({ ...silent, error: (...a) => errors.push(a.join(' ')) }, { platform: 'Lares4Complete', ip: '127.0.0.1', port: server.address().port, https: true, pin: '135790', telemetry: true, reconnectInterval: 600_000 }, api);
    listeners.get('didFinishLaunching')();
    await waitFor(() => errors.some((line) => /initialization error/i.test(line)));
    listeners.get('shutdown')();
    await telemetry.closeTelemetry();
    assert.deepEqual(events(), [], 'a self-signed certificate is a configuration issue, not a bug report');
});
