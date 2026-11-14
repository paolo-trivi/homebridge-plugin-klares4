'use strict';

// PLAT-13: the zone's tamper field reaches StatusTampered; a bypass stays
// StatusActive=false and is not a tamper.

const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');

const { ZoneAccessory } = require('../dist/accessories/zone-accessory.js');

const { Characteristic, Service } = hap;

function zone(status) {
    return { id: 'zone_4', type: 'zone', name: 'Hall Door', description: '', status: { open: false, bypassed: false, armed: false, fault: false, ...status } };
}

function build(device) {
    const accessory = new hap.Accessory(device.name, hap.uuid.generate(device.id));
    const warnings = [];
    const platformAccessory = {
        UUID: accessory.UUID,
        displayName: device.name,
        context: { device },
        getService: (type) => accessory.getService(type),
        addService: (type) => accessory.addService(type),
    };
    const platform = {
        Service, Characteristic, api: { hap },
        log: { info() {}, warn: (m) => warnings.push(m), error() {}, debug() {} },
        config: {},
    };
    const handler = new ZoneAccessory(platform, platformAccessory);
    const service = accessory.getService(Service.ContactSensor);
    return { handler, warnings, tampered: () => service.getCharacteristic(Characteristic.StatusTampered).value, service };
}

test('PLAT-13: StatusTampered follows the zone tamper flag', async () => {
    const { handler, warnings, tampered, service } = build(zone({ tampered: true }));
    assert.equal(tampered(), 1);
    assert.equal(await handler.getStatusTampered(), 1);

    handler.updateStatus(zone({ tampered: false }));
    assert.equal(tampered(), 0);
    handler.updateStatus(zone({ tampered: true }));
    assert.equal(tampered(), 1);
    assert.equal(warnings.filter((w) => /Tamper detected/.test(w)).length, 1);

    handler.updateStatus(zone({ bypassed: true }));
    assert.equal(tampered(), 0, 'a bypass is not a tamper');
    assert.equal(service.getCharacteristic(Characteristic.StatusActive).value, false);
});

test('PLAT-13: a zone whose tamper field was never reported is not tampered', async () => {
    const { handler, tampered } = build(zone({}));
    assert.equal(tampered(), 0);
    assert.equal(await handler.getStatusTampered(), 0);
});
