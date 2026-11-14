const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');
const { checkName } = require('@homebridge/hap-nodejs/dist/lib/util/checkName.js');

const { AccessoryRegistry } = require('../dist/platform/accessory-registry.js');

const { Characteristic, Service } = hap;

// Mirrors homebridge 2.4.0 dist/platformAccessory.js (not reachable through the
// package "exports"): a thin wrapper over a real HAP-NodeJS Accessory.
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
}

function registryHarness() {
    const accessories = new Map();
    const handlers = new Map();
    const registry = new AccessoryRegistry({
        api: {
            hap,
            platformAccessory: PlatformAccessory,
            registerPlatformAccessories: () => undefined,
            unregisterPlatformAccessories: () => undefined,
            updatePlatformAccessories: () => undefined,
        },
        log: { info() {}, warn() {}, debug() {} },
        pluginName: 'plugin',
        platformName: 'platform',
        accessories,
        accessoryHandlers: handlers,
        activeDiscoveredUUIDs: new Set(),
        createAccessoryHandler: () => ({}),
        updateAccessoryHandler: () => undefined,
    });
    return { registry, accessories, handlers };
}

// A cached accessory as Homebridge restores it: displayName, AccessoryInformation
// Name and primary service Name all carry the name saved in a previous session.
function cachedAccessory(savedName, device, primaryService = Service.Lightbulb) {
    const accessory = new PlatformAccessory(savedName, hap.uuid.generate(device.id));
    accessory.addService(primaryService, savedName);
    accessory.context.device = device;
    return accessory;
}

function names(accessory, primaryService = Service.Lightbulb) {
    return {
        displayName: accessory.displayName,
        hapDisplayName: accessory._associatedHAPAccessory.displayName,
        information: accessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.Name).value,
        primary: accessory.getService(primaryService).getCharacteristic(Characteristic.Name).value,
    };
}

function silenceHapWarnings(t) {
    const warnings = [];
    t.mock.method(console, 'warn', (message) => { warnings.push(String(message)); });
    return warnings;
}

test('cached accessory with a legacy invalid name is re-aligned before publish', (t) => {
    silenceHapWarnings(t);
    const { registry } = registryHarness();
    const device = { id: 'light_4', type: 'light', name: 'Luce po’', description: '', status: { on: false, dimmable: false } };
    const accessory = cachedAccessory('Luce po’', device);

    registry.configureAccessory(accessory);

    assert.deepEqual(names(accessory), {
        displayName: 'Luce po', hapDisplayName: 'Luce po', information: 'Luce po', primary: 'Luce po',
    });
    const warnings = silenceHapWarnings(t);
    const info = accessory.getService(Service.AccessoryInformation);
    checkName(accessory.displayName, 'Name', info.getCharacteristic(Characteristic.Name).value);
    assert.deepEqual(warnings, []);
});

test('a device renamed on the panel updates every HAP name of the cached accessory', (t) => {
    silenceHapWarnings(t);
    const { registry, accessories } = registryHarness();
    const oldDevice = { id: 'cover_2', type: 'cover', name: 'Tapparella Sala', description: '', status: { position: 0, state: 'stopped' } };
    const accessory = cachedAccessory('Tapparella Sala', oldDevice, Service.WindowCovering);
    registry.configureAccessory(accessory);
    assert.equal(accessories.get(accessory.UUID), accessory);

    registry.addAccessory({ ...oldDevice, name: 'Tapparella Cucina' });

    assert.deepEqual(names(accessory, Service.WindowCovering), {
        displayName: 'Tapparella Cucina',
        hapDisplayName: 'Tapparella Cucina',
        information: 'Tapparella Cucina',
        primary: 'Tapparella Cucina',
    });
});

test('an unchanged name leaves the cached accessory untouched', (t) => {
    silenceHapWarnings(t);
    const { registry } = registryHarness();
    const device = { id: 'light_9', type: 'light', name: 'Luce Studio', description: '', status: { on: false, dimmable: false } };
    const accessory = cachedAccessory('Luce Studio', device);
    const info = accessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.Name);
    let changes = 0;
    info.on('change', () => { changes += 1; });

    registry.configureAccessory(accessory);
    registry.addAccessory(device);

    assert.equal(changes, 0);
    assert.equal(names(accessory).primary, 'Luce Studio');
});
