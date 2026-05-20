const test = require('node:test');
const assert = require('node:assert/strict');

const {
    toMatterTemperatureCelsius,
    fromMatterTemperatureCelsius,
    clampMatterTemperature,
    domainModeToMatterSystemMode,
    getThermostatPresetWorkaroundAttributes,
    thermostatSupportsCooling,
    buildThermostatMatterState,
    matterSystemModeToKlares4Mode,
    normalizeMatterSetpointC,
    DEFAULT_HEATING_SETPOINT_C,
    DEFAULT_DEADBAND_C,
    DEFAULT_MIN_HEAT_C,
    DEFAULT_MAX_HEAT_C,
    DEFAULT_MIN_COOL_C,
    DEFAULT_MAX_COOL_C,
    TEMP_ABS_MIN_CENTI,
    TEMP_ABS_MAX_CENTI,
    CONTROL_SEQ_HEATING_ONLY,
    CONTROL_SEQ_COOLING_AND_HEATING,
    SYSTEM_MODE_OFF,
    SYSTEM_MODE_HEAT,
    SYSTEM_MODE_COOL,
    SYSTEM_MODE_AUTO,
} = require('../dist/platform/matter-thermostat-mapper.js');

test('toMatterTemperatureCelsius: numeric values', () => {
    assert.equal(toMatterTemperatureCelsius(22.5), 2250);
    assert.equal(toMatterTemperatureCelsius(20), 2000);
    assert.equal(toMatterTemperatureCelsius(0), 0);
    assert.equal(toMatterTemperatureCelsius(-5), -500);
});

test('toMatterTemperatureCelsius: numeric strings', () => {
    assert.equal(toMatterTemperatureCelsius('21'), 2100);
    assert.equal(toMatterTemperatureCelsius('22.5'), 2250);
});

test('toMatterTemperatureCelsius: invalid inputs use fallback', () => {
    assert.equal(toMatterTemperatureCelsius(null, 20), 2000);
    assert.equal(toMatterTemperatureCelsius(undefined, 20), 2000);
    assert.equal(toMatterTemperatureCelsius(NaN, 20), 2000);
    assert.equal(toMatterTemperatureCelsius('not a number', 21), 2100);
});

test('fromMatterTemperatureCelsius: round-trip', () => {
    assert.equal(fromMatterTemperatureCelsius(2250), 22.5);
    assert.equal(fromMatterTemperatureCelsius(toMatterTemperatureCelsius(18.3)), 18.3);
});

test('clampMatterTemperature: bounds are enforced', () => {
    assert.equal(clampMatterTemperature(5000, -27000, 10000), 5000);
    assert.equal(clampMatterTemperature(-30000, -27000, 10000), -27000);
    assert.equal(clampMatterTemperature(15000, -27000, 10000), 10000);
    assert.equal(clampMatterTemperature(NaN, -27000, 10000), -27000);
});

test('domainModeToMatterSystemMode: enum values match Matter spec §4.3.7.32', () => {
    assert.equal(domainModeToMatterSystemMode('off'), SYSTEM_MODE_OFF);
    assert.equal(domainModeToMatterSystemMode('heat'), SYSTEM_MODE_HEAT);
    assert.equal(domainModeToMatterSystemMode('cool'), SYSTEM_MODE_COOL);
    assert.equal(domainModeToMatterSystemMode('auto'), SYSTEM_MODE_AUTO);
    assert.equal(domainModeToMatterSystemMode(undefined), SYSTEM_MODE_OFF);
});

test('getThermostatPresetWorkaroundAttributes: ships exactly one valid preset slot', () => {
    const wa = getThermostatPresetWorkaroundAttributes();
    assert.equal(wa.numberOfPresets, 1);
    assert.ok(Array.isArray(wa.presetTypes));
    assert.equal(wa.presetTypes.length, 1);
    assert.equal(wa.presetTypes[0].presetScenario, 1);             // Occupied
    assert.equal(wa.presetTypes[0].numberOfPresets, 1);
    assert.deepEqual(wa.presetTypes[0].presetTypeFeatures, { automatic: false, supportsNames: false });
});

test('thermostatSupportsCooling: detects Italian + English naming', () => {
    assert.equal(thermostatSupportsCooling({ name: 'Raffrescamento Sala' }), true);
    assert.equal(thermostatSupportsCooling({ name: 'Raffreddamento Camera' }), true);
    assert.equal(thermostatSupportsCooling({ name: 'Climatizzazione Ufficio' }), true);
    assert.equal(thermostatSupportsCooling({ name: 'Cooling Living' }), true);
    assert.equal(thermostatSupportsCooling({ name: 'Riscaldamento Bagno' }), false);
    assert.equal(thermostatSupportsCooling({ name: 'Heating Office' }), false);
    assert.equal(thermostatSupportsCooling({ name: undefined }), false);
});

test('buildThermostatMatterState: heating-only thermostat', () => {
    const device = {
        id: 'thermostat_18',
        name: 'Riscaldamento Sala',
        type: 'thermostat',
        currentTemperature: 21.2,
        targetTemperature: 20,
        mode: 'heat',
        status: {},
    };
    const { base, schemaInvariants } = buildThermostatMatterState(device);

    assert.equal(base.localTemperature, 2120);
    assert.equal(base.occupiedHeatingSetpoint, 2000);
    assert.equal(base.systemMode, SYSTEM_MODE_HEAT);
    assert.equal(schemaInvariants.controlSequenceOfOperation, CONTROL_SEQ_HEATING_ONLY);
    assert.ok(schemaInvariants.minHeatSetpointLimit >= TEMP_ABS_MIN_CENTI);
    assert.ok(schemaInvariants.maxHeatSetpointLimit <= TEMP_ABS_MAX_CENTI);
    assert.equal(schemaInvariants.minSetpointDeadBand, DEFAULT_DEADBAND_C * 10);
    assert.equal(schemaInvariants.numberOfPresets, 1);
    assert.equal(schemaInvariants.presetTypes.length, 1);
});

test('buildThermostatMatterState: cooling-capable thermostat exposes both setpoints', () => {
    const device = {
        id: 'thermostat_34',
        name: 'Raffrescamento Sala',
        type: 'thermostat',
        currentTemperature: 24,
        targetTemperature: 23,
        mode: 'cool',
        status: {},
    };
    const { base, schemaInvariants } = buildThermostatMatterState(device);

    assert.equal(schemaInvariants.controlSequenceOfOperation, CONTROL_SEQ_COOLING_AND_HEATING);
    assert.equal(base.systemMode, SYSTEM_MODE_COOL);
    assert.ok(typeof base.occupiedCoolingSetpoint === 'number');
    assert.ok(base.occupiedCoolingSetpoint - base.occupiedHeatingSetpoint >= schemaInvariants.minSetpointDeadBand * 10);
});

test('buildThermostatMatterState: heating-only coerces stale cool/auto mode to heat', () => {
    const device = {
        id: 'thermostat_x',
        name: 'Riscaldamento Studio',
        type: 'thermostat',
        currentTemperature: 19,
        targetTemperature: 20,
        mode: 'auto', // stale — Lares4 model leaked an auto mode for a heating-only device
        status: {},
    };
    const { base, schemaInvariants } = buildThermostatMatterState(device);
    assert.equal(schemaInvariants.controlSequenceOfOperation, CONTROL_SEQ_HEATING_ONLY);
    assert.equal(base.systemMode, SYSTEM_MODE_HEAT);
});

test('buildThermostatMatterState: NaN / null current temp falls back to default', () => {
    const device = {
        id: 'thermostat_y',
        name: 'Riscaldamento Bagno',
        type: 'thermostat',
        currentTemperature: null,
        targetTemperature: NaN,
        mode: 'heat',
        status: {},
    };
    const { base } = buildThermostatMatterState(device);
    assert.equal(typeof base.localTemperature, 'number');
    assert.equal(base.occupiedHeatingSetpoint, DEFAULT_HEATING_SETPOINT_C * 100);
});

test('buildThermostatMatterState: deadband invariant always holds (cooling - heating >= deadband)', () => {
    // Edge case: heating setpoint at top of range — cooling must shift up too
    const device = {
        id: 'thermostat_edge',
        name: 'Raffrescamento Edge',
        type: 'thermostat',
        currentTemperature: 29,
        targetTemperature: 30, // at max heating
        mode: 'heat',
        status: {},
    };
    const { base, schemaInvariants } = buildThermostatMatterState(device);
    const deadbandCenti = schemaInvariants.minSetpointDeadBand * 10;
    assert.ok(
        base.occupiedCoolingSetpoint - base.occupiedHeatingSetpoint >= deadbandCenti,
        `cooling(${base.occupiedCoolingSetpoint}) - heating(${base.occupiedHeatingSetpoint}) must be >= deadband(${deadbandCenti})`,
    );
});

// ---------------------------------------------------------------------------
// matterSystemModeToKlares4Mode
// ---------------------------------------------------------------------------

test('matterSystemModeToKlares4Mode: heating-only thermostat', () => {
    const supportsCooling = false;
    assert.equal(matterSystemModeToKlares4Mode(SYSTEM_MODE_OFF, supportsCooling), 'off');
    assert.equal(matterSystemModeToKlares4Mode(SYSTEM_MODE_HEAT, supportsCooling), 'heat');
    assert.equal(matterSystemModeToKlares4Mode(SYSTEM_MODE_COOL, supportsCooling), null, 'cool not supported → null');
    assert.equal(matterSystemModeToKlares4Mode(SYSTEM_MODE_AUTO, supportsCooling), null, 'auto not supported → null');
    assert.equal(matterSystemModeToKlares4Mode(99, supportsCooling), null, 'unknown → null');
});

test('matterSystemModeToKlares4Mode: cooling-capable thermostat', () => {
    const supportsCooling = true;
    assert.equal(matterSystemModeToKlares4Mode(SYSTEM_MODE_OFF, supportsCooling), 'off');
    assert.equal(matterSystemModeToKlares4Mode(SYSTEM_MODE_HEAT, supportsCooling), 'heat');
    assert.equal(matterSystemModeToKlares4Mode(SYSTEM_MODE_COOL, supportsCooling), 'cool');
    assert.equal(matterSystemModeToKlares4Mode(SYSTEM_MODE_AUTO, supportsCooling), 'auto');
    assert.equal(matterSystemModeToKlares4Mode(99, supportsCooling), null, 'unknown → null');
});

// ---------------------------------------------------------------------------
// normalizeMatterSetpointC
// ---------------------------------------------------------------------------

test('normalizeMatterSetpointC: converts centidegrees to °C without clamping', () => {
    const { value, clamped } = normalizeMatterSetpointC(2150, DEFAULT_MIN_HEAT_C, DEFAULT_MAX_HEAT_C);
    assert.equal(value, 21.5);
    assert.equal(clamped, false);
});

test('normalizeMatterSetpointC: converts 2000 centidegrees → 20°C without clamping', () => {
    const { value, clamped } = normalizeMatterSetpointC(2000, DEFAULT_MIN_HEAT_C, DEFAULT_MAX_HEAT_C);
    assert.equal(value, 20);
    assert.equal(clamped, false);
});

test('normalizeMatterSetpointC: clamps below-minimum value', () => {
    const { value, clamped } = normalizeMatterSetpointC(0, DEFAULT_MIN_HEAT_C, DEFAULT_MAX_HEAT_C);
    assert.equal(value, DEFAULT_MIN_HEAT_C);
    assert.equal(clamped, true);
});

test('normalizeMatterSetpointC: clamps above-maximum value', () => {
    const { value, clamped } = normalizeMatterSetpointC(9999, DEFAULT_MIN_HEAT_C, DEFAULT_MAX_HEAT_C);
    assert.equal(value, DEFAULT_MAX_HEAT_C);
    assert.equal(clamped, true);
});

test('normalizeMatterSetpointC: works for cooling range', () => {
    const { value, clamped } = normalizeMatterSetpointC(2400, DEFAULT_MIN_COOL_C, DEFAULT_MAX_COOL_C);
    assert.equal(value, 24);
    assert.equal(clamped, false);
});

test('normalizeMatterSetpointC: clamps cooling value below minimum', () => {
    const { value, clamped } = normalizeMatterSetpointC(100, DEFAULT_MIN_COOL_C, DEFAULT_MAX_COOL_C);
    assert.equal(value, DEFAULT_MIN_COOL_C);
    assert.equal(clamped, true);
});
