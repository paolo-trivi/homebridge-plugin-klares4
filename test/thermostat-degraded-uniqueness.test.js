'use strict';

// M2 (rc.1 review): without PRG_THERMOSTATS a guessed cfg id is accepted only
// when it is the one cfg matching the thermostat's realtime state, and is
// remembered only after a discriminating match (MAN, same setpoint).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createThermostatPanel, realisticCfg } = require('./fixtures/thermostat-panel');
const { judgeDegradedGuess } = require('../dist/websocket-client/thermostat-degraded-guess.js');

// Real ownership, unknown to the plugin: room A = output 10, sensor 4, cfg 3;
// room B = output 11, sensor 3, cfg 4. The guess for room A is cfg 4 (its sensor id).
const CROSSED = [{ out: '10', sensor: '4', cfg: '3' }, { out: '11', sensor: '3', cfg: '4' }];

function crossed(mode, { tmA = '20.0', tmB = '20.0' } = {}) {
    const sim = createThermostatPanel({
        thermostats: CROSSED, programs: false,
        cfgs: [realisticCfg('3', { mode, winTm: tmA }), realisticCfg('4', { mode, winTm: tmB })],
    });
    sim.login();
    sim.realtime('3');
    sim.realtime('4');
    return sim;
}

for (const mode of ['AUTO', 'OFF']) {
    test(`M2: crossed pairs both in ${mode}: the write for room A is refused, not sent to room B`, async () => {
        const sim = crossed(mode);
        await assert.rejects(() => sim.service.setThermostatTemperature('thermostat_10', 23), /all match.*manualCommandPairs/);
        await assert.rejects(() => sim.service.setThermostatMode('thermostat_10', 'off'), /manualCommandPairs/);
        assert.deepEqual(sim.panel.writes, []);
        assert.equal(sim.state.thermostatCommandIdByOutputId.size, 0);
    });
}

test('M2: crossed pairs in MAN with different setpoints: refused (the guess does not match)', async () => {
    const sim = crossed('MAN', { tmA: '20.0', tmB: '21.0' });
    await assert.rejects(() => sim.service.setThermostatTemperature('thermostat_10', 23), /does not match/);
    assert.deepEqual(sim.panel.writes, []);
});

test('M2: two thermostats in an identical MAN state cannot be told apart: refused', async () => {
    const sim = createThermostatPanel({
        thermostats: [{ out: '10', sensor: '3' }, { out: '11', sensor: '4' }], programs: false,
        cfgs: [realisticCfg('3', { winTm: '21.0' }), realisticCfg('4', { winTm: '21.0' })],
    });
    sim.login(); sim.realtime('3'); sim.realtime('4');
    await assert.rejects(() => sim.service.setThermostatTemperature('thermostat_10', 23), /cannot be told/);
    assert.deepEqual(sim.panel.writes, []);
});

test('M2: the only matching cfg in MAN is used and remembered', async () => {
    const sim = createThermostatPanel({
        thermostats: [{ out: '10', sensor: '3' }, { out: '11', sensor: '4' }], programs: false,
        cfgs: [realisticCfg('3', { winTm: '21.0' }), realisticCfg('4', { winTm: '19.5' })],
    });
    sim.login(); sim.realtime('3'); sim.realtime('4');
    await sim.service.setThermostatTemperature('thermostat_10', 23);
    assert.deepEqual(sim.panel.writes.map((w) => w.ID), ['3']);
    assert.equal(sim.state.thermostatCommandIdByOutputId.get('10'), '3');
});

test('M2: the only matching cfg in AUTO is used, but checked again at every write', async () => {
    const sim = createThermostatPanel({
        thermostats: [{ out: '10', sensor: '3' }, { out: '11', sensor: '4' }], programs: false,
        cfgs: [realisticCfg('3', { mode: 'AUTO' }), realisticCfg('4', { mode: 'OFF' })],
    });
    sim.login(); sim.realtime('3'); sim.realtime('4');
    await sim.service.setThermostatTemperature('thermostat_10', 23);
    assert.deepEqual(sim.panel.writes.map((w) => w.ID), ['3']);
    assert.equal(sim.state.thermostatCommandIdByOutputId.has('10'), false, 'not remembered');
    // The other room is switched to AUTO on the keypad: from now on both match.
    sim.keypad('4', (c) => { c.ACT_MODE = 'AUTO'; }, { notify: false });
    await assert.rejects(() => sim.service.setThermostatTemperature('thermostat_10', 22), /all match/);
    assert.equal(sim.panel.writes.length, 1);
});

test('M2: judgeDegradedGuess also refuses a cfg matching the realtime of several thermostats', () => {
    const cfgs = new Map([['3', realisticCfg('3', { mode: 'AUTO' })]]);
    const snapshots = new Map([
        ['3', { mode: 'auto', season: 'WIN' }],
        ['4', { mode: 'auto', season: 'WIN' }],
    ]);
    const verdict = judgeDegradedGuess('3', '3', cfgs, snapshots);
    assert.equal(verdict.accepted, false);
    assert.match(verdict.reason, /several thermostats/);
    assert.deepEqual(judgeDegradedGuess('3', '3', cfgs, new Map([['3', { mode: 'auto', season: 'WIN' }]])), { accepted: true, remember: false });
});
