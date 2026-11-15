'use strict';

// Where the user config becomes client options, and which consumer receives
// which device snapshot (TD-T-02, TD-T-07; mutations M29, M30, M52, M53, M54).

const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');

const { Lares4Platform } = require('../dist/platform/index.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });

function fakeApi(storagePath) {
    const listeners = new Map();
    return {
        hap, user: { storagePath: () => storagePath }, platformAccessory: class {},
        registerPlatformAccessories() {}, unregisterPlatformAccessories() {}, updatePlatformAccessories() {},
        on(e, cb) { listeners.set(e, cb); }, emit(e) { return listeners.get(e)?.(); },
    };
}

async function bootPlatform(t, extraConfig) {
    const api = fakeApi(tmpStorage(t, 'klares4-wiring-'));
    const platform = new Lares4Platform(silentLog(), { platform: 'Lares4Complete', ip: '127.0.0.1', port: 1, https: true, pin: '135790', telemetry: false, reconnectInterval: 600_000, ...extraConfig }, api);
    t.after(() => api.emit('shutdown'));
    api.emit('didFinishLaunching');
    await waitFor(() => platform.wsClient !== undefined);
    return platform;
}

test('the platform hands safe defaults to the client (no partial-arm exposure, strict TLS)', { timeout: 10000 }, async (t) => {
    const platform = await bootPlatform(t, {});
    assert.equal(platform.wsClient['options'].exposePartialArmScenarios, false);
    assert.equal(platform.wsClient['options'].allowInsecureTls, false);
    for (const truthy of ['true', 1, 'yes']) {
        const p = await bootPlatform(t, { exposePartialArmScenarios: truthy });
        assert.equal(p.wsClient['options'].exposePartialArmScenarios, false, `non-boolean ${JSON.stringify(truthy)} must not opt in`);
    }
});

function bootSpiedPlatform(t, config) {
    const api = fakeApi(tmpStorage(t, 'klares4-wiring-'));
    const platform = new Lares4Platform(silentLog(), { platform: 'Lares4Complete', ip: '127.0.0.1', port: 1, https: false, pin: '135790', telemetry: false, ...config }, api);
    t.after(() => api.emit('shutdown'));
    const seen = { hap: [], hapUpdate: [], mqtt: [], matter: [], matterUpdate: [] };
    platform['accessoryRegistry'].addAccessory = (d) => seen.hap.push(d);
    platform['accessoryRegistry'].updateAccessory = (d) => seen.hapUpdate.push(d);
    platform.mqttBridge = { publishDeviceState: (d) => seen.mqtt.push(d), disconnect() {}, setPanelConnected() {} };
    platform.matterRegistry.addOrUpdateAccessory = async (d) => { seen.matter.push(d); };
    platform.matterRegistry.updateAccessoryState = async (d) => { seen.matterUpdate.push(d); };
    return { platform, seen };
}
const zone = (id, name) => ({ id: `zone_${id}`, type: 'zone', name, description: name, status: { armed: false, bypassed: false, fault: false, open: false } });

test('a device excluded in the config reaches neither HAP, MQTT nor Matter', (t) => {
    const { platform, seen } = bootSpiedPlatform(t, { excludeZones: ['7'] });
    platform['deviceEvents'].handleDeviceDiscovered(zone(7, 'Zona esclusa'));
    platform['deviceEvents'].handleDeviceDiscovered(zone(8, 'Zona esposta'));
    assert.deepEqual(seen.hap.map((d) => d.id), ['zone_8']);
    assert.deepEqual(seen.matter.map((d) => d.id), ['zone_8']);
});

test('the Matter-only name goes to Matter alone; HAP and MQTT keep the shared name', (t) => {
    const { platform, seen } = bootSpiedPlatform(t, { matterOverrides: [{ deviceId: 'zone_8', name: 'Nome solo Matter' }] });
    const source = zone(8, 'Zona sorgente');
    platform['deviceEvents'].handleDeviceDiscovered(source);
    platform['deviceEvents'].handleDeviceStatusUpdate(source);
    assert.equal(seen.matter[0].name, 'Nome solo Matter');
    assert.equal(seen.matterUpdate[0].name, 'Nome solo Matter');
    assert.equal(seen.hap[0].name, 'Zona sorgente');
    assert.equal(seen.hapUpdate[0].name, 'Zona sorgente');
    assert.equal(seen.mqtt[0].name, 'Zona sorgente');
    assert.equal(source.name, 'Zona sorgente', 'the source snapshot is never renamed');
});
