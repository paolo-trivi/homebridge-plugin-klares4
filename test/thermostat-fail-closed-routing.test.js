'use strict';

// TH-04 / TH-17: a write whose cfg id is not certain is refused, never guessed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createThermostatPanel, realisticCfg } = require('./fixtures/thermostat-panel');
const { buildDomusThermostatMapping } = require('../dist/websocket-client/domus-thermostat-mapper.js');

// Degraded install (no PRG_THERMOSTATS), crossed pairs: output 21 measures
// sensor 4 but is cfg 3; output 20 measures sensor 3 but is cfg 4.
const CROSSED = [{ out: '20', sensor: '3', cfg: '4' }, { out: '21', sensor: '4', cfg: '3' }];
const crossedCfgs = () => [realisticCfg('3', { winTm: '19.0' }), realisticCfg('4', { winTm: '21.0' })];

function degraded(options = {}) {
    const sim = createThermostatPanel({ thermostats: CROSSED, cfgs: crossedCfgs(), programs: false, ...options });
    sim.login();
    sim.realtime('3');
    sim.realtime('4');
    return sim;
}

test('TH-04 (a): crossed pairs without a manual pair: the guess does not match the realtime, write refused', async () => {
    const sim = degraded();
    await assert.rejects(() => sim.service.setThermostatTemperature('thermostat_21', 24), /manualCommandPairs/);
    await assert.rejects(() => sim.service.setThermostatMode('thermostat_21', 'off'), /manualCommandPairs/);
    assert.deepEqual(sim.panel.writes, []);
    assert.ok(sim.log.lines.error.some((line) => line.includes('thermostat_21')));
});

test('TH-04 (b): the correct manual pair writes the right cfg', async () => {
    const sim = degraded({ manualCommandPairs: [{ thermostatOutputId: '21', commandThermostatId: '3' }] });
    await sim.service.setThermostatTemperature('thermostat_21', 24);
    assert.deepEqual(sim.panel.writes.map((w) => w.ID), ['3']);
    assert.equal(sim.panel.cfg.get('4').WIN.TM, '21.0');
});

test('TH-04 (c): a manual pair naming a cfg the panel does not have is refused, not guessed', async () => {
    const sim = degraded({ manualCommandPairs: [{ thermostatOutputId: '21', commandThermostatId: '7' }] });
    await assert.rejects(() => sim.service.setThermostatTemperature('thermostat_21', 24), /cfg id 7 .*could not be read/);
    assert.deepEqual(sim.panel.writes, []);
});

test('TH-04 (d): a manual pair whose cfg cannot be read (READ timeout) is refused', async () => {
    const sim = degraded({ manualCommandPairs: [{ thermostatOutputId: '21', commandThermostatId: '3' }] });
    sim.state.thermostatCfgById.delete('3');
    sim.panel.readFails = true;
    await assert.rejects(() => sim.service.setThermostatTemperature('thermostat_21', 24), /could not be read/);
    assert.deepEqual(sim.panel.writes, []);
});

test('TH-04 / TH-17: the program cfg not readable: no blind payload, nothing sent', async () => {
    const sim = createThermostatPanel({
        thermostats: [{ out: '18', sensor: '1', cfg: '1' }],
        cfgs: [realisticCfg('1', { mode: 'OFF', season: 'SUM' })],
        readFails: true,
    });
    await assert.rejects(() => sim.service.setThermostatTemperature('thermostat_18', 22), /PRG_THERMOSTATS.*could not be read/);
    await assert.rejects(() => sim.service.setThermostatMode('thermostat_18', 'heat'), /could not be read/);
    assert.deepEqual(sim.sent.filter((s) => s.cmd === 'WRITE_CFG'), []);
});

test('TH-04: an output in no program is refused when PRG_THERMOSTATS is known', async () => {
    const sim = createThermostatPanel({
        thermostats: [{ out: '18', sensor: '1', cfg: '1' }, { out: '30' }],
        cfgs: [realisticCfg('1'), realisticCfg('30')],
    });
    sim.login();
    await assert.rejects(() => sim.service.setThermostatTemperature('thermostat_30', 22), /not the heating or cooling output/);
    assert.deepEqual(sim.panel.writes, []);
});

test('TH-04: a degraded guess coherent with the realtime is used', async () => {
    const sim = createThermostatPanel({
        thermostats: [{ out: '20', sensor: '3' }],
        cfgs: [realisticCfg('3', { winTm: '19.0' })],
        programs: false,
    });
    sim.login();
    sim.realtime('3');
    await sim.service.setThermostatTemperature('thermostat_20', 23);
    assert.deepEqual(sim.panel.writes.map((w) => w.ID), ['3']);
});

test('TH-04: a degraded guess without any realtime to check it against is refused', async () => {
    const sim = createThermostatPanel({ thermostats: [{ out: '20', sensor: '3' }], cfgs: [realisticCfg('3')], programs: false });
    sim.login();
    await assert.rejects(() => sim.service.setThermostatTemperature('thermostat_20', 23), /no realtime state.*manualCommandPairs/);
    assert.deepEqual(sim.panel.writes, []);
});

test('TH-04: the cfg sync never shows a guessed cfg', () => {
    const sim = createThermostatPanel({ thermostats: CROSSED, cfgs: crossedCfgs(), programs: false });
    sim.login();
    const device = sim.state.devices.get('thermostat_21');
    assert.equal(device.status.mode, 'off', 'unchanged until its realtime arrives');
    assert.equal(sim.state.thermostatCommandIdByOutputId.size, 0);
});

const mapping = (thermostats, sensors, manualPairs = []) => buildDomusThermostatMapping({
    thermostatOutputs: new Map(thermostats.map(([id, name]) => [id, { id, name }])),
    domusSensors: new Map(sensors.map(([id, name]) => [id, { id, name }])),
    manualPairs,
}).mapping;

test('TH-04: name mapping does not hand one room\'s sensor to another room', () => {
    const result = mapping([['20', 'Zone Day'], ['21', 'Zone Night']], [['1', 'Zone Day']]);
    assert.equal(result.get('20'), '1');
    assert.equal(result.has('21'), false);
});

test('TH-04: name mapping still shares a sensor between full matches (heating and cooling of one room)', () => {
    const result = mapping([['18', 'Riscaldamento Room'], ['34', 'Raffrescamento Room']], [['1', 'Room'], ['2', 'Hall']]);
    assert.equal(result.get('18'), '1');
    assert.equal(result.get('34'), '1');
});

test('TH-04: two partial matches for one sensor: neither is mapped', () => {
    const result = mapping([['20', 'Room North'], ['21', 'Room South']], [['1', 'Room']]);
    assert.equal(result.size, 0);
});

test('TH-04: a sensor taken by a manual pair is not auto-mapped to a partial match', () => {
    const result = mapping(
        [['20', 'Room'], ['21', 'Room Guest']],
        [['1', 'Room'], ['2', 'Hall']],
        [{ thermostatOutputId: '20', domusSensorId: '1' }],
    );
    assert.equal(result.get('20'), '1');
    assert.equal(result.has('21'), false);
});
