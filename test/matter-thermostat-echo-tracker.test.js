const test = require('node:test');
const assert = require('node:assert/strict');

const { MatterThermostatEchoTracker } = require('../dist/platform/matter-thermostat-echo-tracker.js');

test('MatterThermostatEchoTracker: empty tracker reports no echoes', () => {
    const t = new MatterThermostatEchoTracker();
    assert.equal(t.isEcho('thermostat_21', 'occupiedHeatingSetpoint', 2400), false);
});

test('MatterThermostatEchoTracker: recordPushed extracts only tracked attrs', () => {
    const t = new MatterThermostatEchoTracker();
    t.recordPushed('thermostat_21', {
        localTemperature: 2120,           // ignored
        occupiedHeatingSetpoint: 2400,
        occupiedCoolingSetpoint: 2600,
        systemMode: 4,
        controlSequenceOfOperation: 2,    // ignored
    });
    assert.equal(t.isEcho('thermostat_21', 'occupiedHeatingSetpoint', 2400), true);
    assert.equal(t.isEcho('thermostat_21', 'occupiedCoolingSetpoint', 2600), true);
    assert.equal(t.isEcho('thermostat_21', 'systemMode', 4), true);
    // Different value → not an echo
    assert.equal(t.isEcho('thermostat_21', 'occupiedHeatingSetpoint', 2300), false);
});

test('MatterThermostatEchoTracker: entries are scoped per accessory UUID', () => {
    const t = new MatterThermostatEchoTracker();
    t.recordPushed('thermostat_21', { occupiedHeatingSetpoint: 2400 });
    assert.equal(t.isEcho('thermostat_21', 'occupiedHeatingSetpoint', 2400), true);
    assert.equal(t.isEcho('thermostat_20', 'occupiedHeatingSetpoint', 2400), false);
});

test('MatterThermostatEchoTracker: recordIntent stores a single attribute', () => {
    const t = new MatterThermostatEchoTracker();
    t.recordIntent('thermostat_21', 'occupiedHeatingSetpoint', 2400);
    assert.equal(t.isEcho('thermostat_21', 'occupiedHeatingSetpoint', 2400), true);
});

test('MatterThermostatEchoTracker: expired entries are not treated as echoes', async () => {
    const t = new MatterThermostatEchoTracker(40);
    t.recordPushed('thermostat_21', { occupiedHeatingSetpoint: 2400 });
    await new Promise(r => setTimeout(r, 60));
    assert.equal(t.isEcho('thermostat_21', 'occupiedHeatingSetpoint', 2400), false);
});

test('MatterThermostatEchoTracker: clear() drops all entries for a UUID', () => {
    const t = new MatterThermostatEchoTracker();
    t.recordPushed('thermostat_21', { occupiedHeatingSetpoint: 2400, systemMode: 4 });
    t.recordPushed('thermostat_20', { occupiedHeatingSetpoint: 2400 });
    t.clear('thermostat_21');
    assert.equal(t.isEcho('thermostat_21', 'occupiedHeatingSetpoint', 2400), false);
    assert.equal(t.isEcho('thermostat_21', 'systemMode', 4), false);
    assert.equal(t.isEcho('thermostat_20', 'occupiedHeatingSetpoint', 2400), true);
});
