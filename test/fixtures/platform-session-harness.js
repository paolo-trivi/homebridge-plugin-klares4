'use strict';

// A Lares4Platform wired to the mock panel (127.0.0.1), a HAP stand-in backed
// by real HAP-NodeJS accessories and, optionally, the Homebridge 2.4 Matter
// model. It drives the real platform lifecycle: didFinishLaunching, login,
// discovery syncs, reconnects, shutdown.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hap = require('@homebridge/hap-nodejs');

const { recordingLog } = require('./lares4-mock-panel.js');

// Mirrors homebridge dist/platformAccessory.js: a thin wrapper over a HAP Accessory.
class PlatformAccessory {
    constructor(displayName, uuid) {
        this._associatedHAPAccessory = new hap.Accessory(displayName, uuid);
        this.displayName = displayName;
        this.UUID = uuid;
        this.context = {};
        this.services = this._associatedHAPAccessory.services;
    }

    updateDisplayName(name) {
        if (name) {
            this.displayName = name;
            this._associatedHAPAccessory.displayName = name;
        }
    }

    addService(service, ...args) {
        return this._associatedHAPAccessory.addService(service, ...args);
    }

    getService(name) {
        return this._associatedHAPAccessory.getService(name);
    }

    getServiceById(uuid, subtype) {
        return this._associatedHAPAccessory.getServiceById(uuid, subtype);
    }

    removeService(service) {
        return this._associatedHAPAccessory.removeService(service);
    }
}

/**
 * `bridge`: a real `hap.Bridge`; registration then goes through
 * `addBridgedAccessories` exactly like homebridge's bridgeService (and hits
 * its 149-accessory limit). `onRegister(accessories)` runs first and may throw.
 */
function fakeApi(storagePath, { matter, bridge, onRegister } = {}) {
    const listeners = new Map();
    const registered = [];
    const unregistered = [];
    return {
        hap,
        matter,
        user: { storagePath: () => storagePath },
        platformAccessory: PlatformAccessory,
        registered,
        unregistered,
        registerPlatformAccessories(_plugin, _platform, accessories) {
            onRegister?.(accessories);
            if (bridge) bridge.addBridgedAccessories(accessories.map((a) => a._associatedHAPAccessory));
            registered.push(...accessories.map((a) => a.context.device.id));
        },
        updatePlatformAccessories() {},
        unregisterPlatformAccessories(_plugin, _platform, accessories) {
            unregistered.push(...accessories.map((a) => a.context.device?.id ?? a.UUID));
        },
        on(event, callback) { listeners.set(event, callback); },
        emit(event) { return listeners.get(event)?.(); },
    };
}

/** Creates the platform; `t.after` shuts it down and removes the storage. */
function createPlatform(t, { port, config = {}, matter, bridge, onRegister } = {}) {
    const { Lares4Platform } = require('../../dist/platform/index.js');
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-session-'));
    const api = fakeApi(storagePath, { matter, bridge, onRegister });
    const log = recordingLog();
    const platform = new Lares4Platform(log, {
        platform: 'Lares4Complete',
        ip: '127.0.0.1',
        port,
        https: false,
        pin: '135790',
        telemetry: false,
        reconnectInterval: 20,
        heartbeatInterval: 60_000,
        ...config,
    }, api);
    t.after(() => {
        api.emit('shutdown');
        fs.rmSync(storagePath, { recursive: true, force: true });
    });
    return { platform, api, log, storagePath };
}

module.exports = { PlatformAccessory, fakeApi, createPlatform };
