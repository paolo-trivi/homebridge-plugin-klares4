'use strict';

// TH-02 (F20): thermostat writes carry only what the command changes, in the
// shapes the official web app sends; a setpoint re-reads the cfg first.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createThermostatPanel, realisticCfg, clone, deepDiff } = require('./fixtures/thermostat-panel');

const ONE = [{ out: '18', sensor: '1', cfg: '1' }];

function connected(cfgOptions) {
    const sim = createThermostatPanel({ thermostats: ONE, cfgs: [realisticCfg('1', cfgOptions)] });
    sim.login();
    sim.realtime('1');
    return sim;
}

test('TH-02 S1: a setpoint on a thermostat switched OFF on the keypad keeps it OFF', async () => {
    const sim = connected({ mode: 'MAN' });
    sim.keypad('1', (c) => { c.ACT_MODE = 'OFF'; });
    await sim.service.setThermostatTemperature('thermostat_18', 21);
    assert.equal(sim.panel.cfg.get('1').ACT_MODE, 'OFF');
    assert.equal(sim.panel.cfg.get('1').WIN.TM, '21.0');
});

test('TH-02 S1b: a setpoint on a thermostat switched ON on the keypad keeps it ON', async () => {
    const sim = connected({ mode: 'OFF' });
    sim.keypad('1', (c) => { c.ACT_MODE = 'MAN'; }, { notify: false });
    await sim.service.setThermostatTemperature('thermostat_18', 21);
    assert.equal(sim.panel.cfg.get('1').ACT_MODE, 'MAN');
});

test('TH-02 S1c: a setpoint keeps an AUTO program selected on the keypad', async () => {
    const sim = connected({ mode: 'MAN' });
    sim.keypad('1', (c) => { c.ACT_MODE = 'AUTO'; }, { notify: false });
    await sim.service.setThermostatTemperature('thermostat_18', 21);
    assert.equal(sim.panel.cfg.get('1').ACT_MODE, 'AUTO');
});

test('TH-02 S2: a mode change does not bring back the setpoint read at login', async () => {
    const sim = connected({ mode: 'MAN', winTm: '20.0' });
    sim.keypad('1', (c) => { c.WIN.TM = '22.5'; }, { notify: false });
    await sim.service.setThermostatMode('thermostat_18', 'off');
    await sim.service.setThermostatMode('thermostat_18', 'heat');
    assert.equal(sim.panel.cfg.get('1').WIN.TM, '22.5');
    assert.deepEqual(sim.panel.writes, [
        { ID: '1', ACT_MODE: 'OFF' },
        { ID: '1', ACT_MODE: 'MAN' },
    ]);
});

test('TH-02 S2b: switching OFF does not revert a season changed on the keypad', async () => {
    const sim = connected({ mode: 'MAN', season: 'WIN' });
    sim.keypad('1', (c) => { c.ACT_SEA = 'SUM'; }, { notify: false });
    await sim.service.setThermostatMode('thermostat_18', 'off');
    assert.equal(sim.panel.cfg.get('1').ACT_SEA, 'SUM');
    assert.deepEqual(sim.panel.writes, [{ ID: '1', ACT_MODE: 'OFF' }]);
});

test('TH-02 S3: one setpoint changes exactly one field on the panel', async () => {
    const sim = connected({ mode: 'MAN' });
    sim.keypad('1', (c) => {
        c.WIN.T1 = '17.0'; c.WIN.T3 = '22.5'; c.WIN.MON[1] = { T: '7.5', S: '3' }; c.WIN.SD1[0].S = '2';
        c.SUM.TM = '27.5'; c.SUM.T2 = '25.0'; c.TOF = { T: '7.0', E: 'T' }; c.MAN_HRS = '4';
    }, { notify: false });
    const before = clone(sim.panel.cfg.get('1'));
    await sim.service.setThermostatTemperature('thermostat_18', 21);
    assert.deepEqual(deepDiff(before, sim.panel.cfg.get('1')), ['WIN.TM']);
    const write = sim.panel.writes.at(-1);
    assert.deepEqual(Object.keys(write), ['ID', 'WIN']);
    assert.deepEqual(write.WIN, { ...before.WIN, TM: '21.0' });
});

test('TH-02: every setpoint re-reads its cfg right before the write', async () => {
    const sim = connected({ mode: 'MAN' });
    await sim.service.setThermostatTemperature('thermostat_18', 21);
    await sim.service.setThermostatTemperature('thermostat_18', 22);
    const order = sim.sent.map((s) => s.cmd);
    assert.deepEqual(order, ['READ', 'WRITE_CFG', 'READ', 'WRITE_CFG']);
    assert.deepEqual(sim.panel.reads, ['1', '1']);
});

test('TH-02: a setpoint lands in the season the panel is in now', async () => {
    const sim = connected({ mode: 'MAN', season: 'WIN', sumTm: '26.0' });
    sim.keypad('1', (c) => { c.ACT_SEA = 'SUM'; }, { notify: false });
    await sim.service.setThermostatTemperature('thermostat_18', 24);
    assert.deepEqual(Object.keys(sim.panel.writes.at(-1)), ['ID', 'SUM']);
    assert.equal(sim.panel.cfg.get('1').SUM.TM, '24.0');
    assert.equal(sim.panel.cfg.get('1').WIN.TM, '20.0');
});

test('TH-02: a setpoint is refused, with nothing sent, when the cfg cannot be re-read', async () => {
    const sim = connected({ mode: 'OFF', season: 'SUM' });
    sim.panel.readFails = true;
    await assert.rejects(() => sim.service.setThermostatTemperature('thermostat_18', 22), /could not be read/);
    assert.deepEqual(sim.panel.writes, []);
});

test('TH-02: NM_CHANGES after a keypad change drops the cfg cache; after our own writes it does not', async () => {
    const sim = connected({ mode: 'MAN' });
    await sim.service.setThermostatMode('thermostat_18', 'off');
    sim.notifyChanges();
    assert.ok(sim.state.thermostatCfgById.has('1'), 'own write: cache kept');

    sim.keypad('1', (c) => { c.ACT_MODE = 'AUTO'; });
    assert.equal(sim.state.thermostatCfgById.size, 0, 'foreign change: cache dropped');

    const readsBefore = sim.panel.reads.length;
    await sim.service.setThermostatMode('thermostat_18', 'heat');
    assert.equal(sim.panel.reads.length, readsBefore + 1, 'the next write reads the cfg again');
});

test('TH-02: a NM_CHANGES lagging behind several of our writes is still ours', async () => {
    const { handleCfgChangeNotification, recordCfgRead, recordOwnCfgWrite } = require('../dist/websocket-client/thermostat-cfg-freshness.js');
    const state = { thermostatCfgById: new Map([['1', {}]]) };
    recordCfgRead(state, ['1'], { CFG: '0000011180' });
    for (let i = 0; i < 4; i += 1) recordOwnCfgWrite(state);
    // The panel coalesces: one notification for four writes, then one for the last.
    assert.equal(handleCfgChangeNotification(state, { CFG: '0000011183' }), false);
    assert.equal(handleCfgChangeNotification(state, { CFG: '0000011184' }), false);
    assert.equal(state.thermostatCfgById.size, 1);
    assert.equal(handleCfgChangeNotification(state, { CFG: '0000011185' }), true);
    assert.equal(state.thermostatCfgById.size, 0);
    assert.equal(handleCfgChangeNotification(state, { CFG: 'x' }), false, 'malformed counter ignored');
});

test('TH-02: mode payloads are the official app shapes; ACT_SEA only to change season', async () => {
    const sim = connected({ mode: 'MAN', season: 'WIN' });
    for (const mode of ['off', 'auto', 'heat', 'cool', 'cool', 'heat']) await sim.service.setThermostatMode('thermostat_18', mode);
    assert.deepEqual(sim.panel.writes, [
        { ID: '1', ACT_MODE: 'OFF' },
        { ID: '1', ACT_MODE: 'AUTO' },
        { ID: '1', ACT_MODE: 'MAN' },
        { ID: '1', ACT_MODE: 'MAN', ACT_SEA: 'SUM' },
        { ID: '1', ACT_MODE: 'MAN' },
        { ID: '1', ACT_MODE: 'MAN', ACT_SEA: 'WIN' },
    ]);
});

test('TH-02: Heat on a thermostat the keypad moved to summer sends the season', async () => {
    const sim = connected({ mode: 'OFF', season: 'WIN' });
    sim.keypad('1', (c) => { c.ACT_SEA = 'SUM'; }, { notify: false });
    await sim.service.setThermostatMode('thermostat_18', 'heat');
    assert.deepEqual(sim.panel.writes, [{ ID: '1', ACT_MODE: 'MAN', ACT_SEA: 'WIN' }]);
});
