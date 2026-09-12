const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    normalizeMatterOverrides,
    normalizeMatterRecoveryRequests,
} = require('../dist/platform/matter-override-config.js');

const { DiscoveryService } = require('../dist/platform/discovery-service.js');

function silentLog() {
    return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

// ---------------------------------------------------------------------------
// Both config shapes must resolve identically.
// ---------------------------------------------------------------------------

test('array form and map form produce the same overrides', () => {
    const fromArray = normalizeMatterOverrides([
        { deviceId: 'zone_18', name: 'Contatto Studio' },
        { deviceId: 'scenario_14', exposed: false },
    ]);
    const fromMap = normalizeMatterOverrides({
        zone_18: { name: 'Contatto Studio' },
        scenario_14: { exposed: false },
    });

    assert.deepEqual(fromArray, fromMap);
    assert.equal(fromArray.zone_18.name, 'Contatto Studio');
    assert.equal(fromArray.scenario_14.exposed, false);
});

test('malformed override rows are dropped, not thrown on', () => {
    const normalized = normalizeMatterOverrides([
        { name: 'senza device id' },
        { deviceId: '   ' },
        { deviceId: 'zone_19' },
        { deviceId: 'zone_20', name: '   ' },
        { deviceId: ' zone_21 ', name: '  Contatto Sala  ' },
    ]);

    assert.deepEqual(Object.keys(normalized), ['zone_21']);
    assert.equal(normalized.zone_21.name, 'Contatto Sala');
});

test('recovery generations accept both shapes and reject invalid values', () => {
    assert.deepEqual(
        normalizeMatterRecoveryRequests([{ deviceId: 'thermostat_18', generation: 2 }]),
        { thermostat_18: 2 },
    );
    assert.deepEqual(normalizeMatterRecoveryRequests({ thermostat_18: 2 }), { thermostat_18: 2 });
    assert.deepEqual(normalizeMatterRecoveryRequests([
        { deviceId: 'thermostat_19', generation: 0 },
        { deviceId: 'thermostat_20', generation: 1.5 },
        { deviceId: 'thermostat_21' },
    ]), {});
    assert.deepEqual(normalizeMatterRecoveryRequests(undefined), {});
});

test('array-form overrides reach the Matter policy without touching shared names', () => {
    const service = new DiscoveryService({
        matterOverrides: [{ deviceId: 'zone_18', name: 'Contatto Studio' }],
    }, silentLog());
    const device = { id: 'zone_18', type: 'zone', name: 'Finestra Studio' };

    const names = service.resolveDeviceNames(device);
    assert.equal(names.matterName, 'Contatto Studio');
    assert.equal(names.nameSource, 'matter-override');
    // HomeKit and MQTT keep the panel's own name.
    assert.equal(names.effectiveSharedName, 'Finestra Studio');
    assert.equal(service.applyCustomName(device).name, 'Finestra Studio');
});

// ---------------------------------------------------------------------------
// The schema must declare the shape the Homebridge UI can round-trip. A
// free-form object keyed by device ID is silently dropped when the UI rewrites
// config.json, which is how a live matterOverrides block was lost in 2.2.0-rc.1.
// ---------------------------------------------------------------------------

test('config schema declares UI-preservable array shapes', () => {
    const schema = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'),
    );
    const props = schema.schema.properties;

    for (const key of ['matterOverrides', 'matterRecoveryRequests']) {
        assert.equal(props[key].type, 'array', `${key} must be an array`);
        assert.equal(props[key].items.properties.deviceId.type, 'string');
        assert.equal(props[key].items.properties.deviceId.required, true);
    }
    assert.equal(props.matterUnregisterTimeoutMs.type, 'integer');
});
