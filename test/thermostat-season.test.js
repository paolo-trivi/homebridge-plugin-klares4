const test = require('node:test');
const assert = require('node:assert/strict');

const { createThermostatPanel, realisticCfg } = require('./fixtures/thermostat-panel');

// F06: a setpoint lands in the block of the season the panel is in.
// TH-02 changed the payload: a setpoint is `{ID, <season>: block}` only.
function connected(cfgOptions, options = {}) {
    const sim = createThermostatPanel({
        thermostats: [{ out: '18', sensor: '1', cfg: '1' }],
        cfgs: [realisticCfg('1', cfgOptions)],
        ...options,
    });
    sim.login();
    sim.realtime('1');
    return sim;
}

test('F06: summer cfg without a session hint writes the summer setpoint', async () => {
    const sim = connected({ mode: 'OFF', season: 'SUM' });
    await sim.service.setThermostatTemperature('thermostat_18', 23);
    const write = sim.panel.writes[0];
    assert.deepEqual(Object.keys(write), ['ID', 'SUM']);
    assert.equal(write.SUM.TM, '23.0');
    assert.equal(sim.panel.cfg.get('1').WIN.TM, '20.0');
});

test('a setpoint keeps the thermostat mode: OFF stays OFF, AUTO stays AUTO, MAN stays MAN', async () => {
    for (const mode of ['OFF', 'AUTO', 'MAN']) {
        const sim = connected({ mode });
        await sim.service.setThermostatTemperature('thermostat_18', 22);
        assert.equal('ACT_MODE' in sim.panel.writes[0], false, mode);
        assert.equal(sim.panel.cfg.get('1').ACT_MODE, mode);
        assert.equal(sim.panel.cfg.get('1').WIN.TM, '22.0');
    }
});

test('a setpoint never forces MAN, even when the cfg has no mode', async () => {
    const sim = connected({ mode: 'MAN', season: 'SUM' });
    delete sim.panel.cfg.get('1').ACT_MODE;
    await sim.service.setThermostatTemperature('thermostat_18', 24);
    assert.deepEqual(Object.keys(sim.panel.writes[0]), ['ID', 'SUM']);
});

test('F06: a rejected "cool" command does not move later setpoints to the summer season', async () => {
    const sim = connected({ mode: 'MAN', season: 'WIN' });
    sim.panel.writeFails = true;
    await assert.rejects(() => sim.service.setThermostatMode('thermostat_18', 'cool'));
    sim.panel.writeFails = false;
    await sim.service.setThermostatTemperature('thermostat_18', 21);
    const panel = sim.panel.cfg.get('1');
    assert.deepEqual([panel.ACT_SEA, panel.WIN.TM, panel.SUM.TM], ['WIN', '21.0', '26.0']);
});

test('F06: a season changed on the panel (realtime) wins over an older acknowledged write', async () => {
    const sim = connected({ mode: 'MAN', season: 'WIN' }, { realtimeAfterWrite: false });
    await sim.service.setThermostatMode('thermostat_18', 'cool');
    sim.keypad('1', (c) => { c.ACT_SEA = 'WIN'; }, { notify: false });
    await sim.service.setThermostatTemperature('thermostat_18', 20);
    assert.deepEqual(Object.keys(sim.panel.writes.at(-1)), ['ID', 'WIN']);
    assert.equal(sim.panel.cfg.get('1').WIN.TM, '20.0');
});

test('F06: an acknowledged "cool" is used for the next setpoint before realtime catches up', async () => {
    const sim = connected({ mode: 'MAN', season: 'WIN' }, { realtimeAfterWrite: false });
    await sim.service.setThermostatMode('thermostat_18', 'cool');
    await sim.service.setThermostatTemperature('thermostat_18', 25);
    assert.deepEqual(Object.keys(sim.panel.writes.at(-1)), ['ID', 'SUM']);
    assert.equal(sim.panel.cfg.get('1').SUM.TM, '25.0');
});

// Swapped (cfg, sensor) pairs, as on real installs: output 21 is cfg 3 with
// DOMUS sensor 4, output 20 is cfg 4 with DOMUS sensor 3. STATUS_TEMPERATURES
// is keyed by the DOMUS sensor id, never by the cfg id.
test('F06: the season is looked up for the thermostat written, not for the sensor sharing its cfg id', async () => {
    const sim = createThermostatPanel({
        thermostats: [{ out: '21', sensor: '4', cfg: '3' }, { out: '20', sensor: '3', cfg: '4' }],
        cfgs: [realisticCfg('3', { season: 'SUM', winTm: '21.5' }), realisticCfg('4', { season: 'WIN' })],
    });
    sim.login();
    sim.realtime('3');
    sim.realtime('4');
    await sim.service.setThermostatTemperature('thermostat_21', 24);
    assert.deepEqual(sim.panel.writes[0], { ID: '3', SUM: { ...realisticCfg('3').SUM, TM: '24.0' } });
    await sim.service.setThermostatTemperature('thermostat_20', 22);
    assert.equal(sim.panel.writes[1].ID, '4');
    assert.equal(sim.panel.writes[1].WIN.TM, '22.0');
});
