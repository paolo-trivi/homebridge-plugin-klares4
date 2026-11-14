'use strict';

// TH-06, TH-03, TH-16: what the client tells HomeKit/Matter/MQTT about a
// thermostat, through the real message pipeline (no socket).
const test = require('node:test');
const assert = require('node:assert/strict');
const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { realisticCfg, silentLog } = require('./fixtures/thermostat-panel');

function client() {
    const log = silentLog();
    const c = new KseniaWebSocketClient('127.0.0.1', 443, true, 'x', '000000', log, {});
    const emits = [];
    c.onDeviceStatusUpdate = (d) => {
        if (d.type === 'thermostat') emits.push({ mode: d.status.mode, target: d.status.targetTemperature, current: d.status.currentTemperature });
    };
    const msg = (CMD, PAYLOAD_TYPE, PAYLOAD) => c.messageService.handleMessage(JSON.stringify({
        SENDER: 'p', RECEIVER: 'x', CMD, ID: '1', PAYLOAD_TYPE, PAYLOAD, TIMESTAMP: '0', CRC_16: '0x0',
    }));
    const multi = (sensors = [{ ID: '1', DES: 'Room' }]) => msg('READ_RES', 'MULTI_TYPES', {
        RESULT: 'OK', OUTPUTS: [{ ID: '18', DES: 'Riscaldamento Room', CAT: 'THERMO', MOD: 'C' }], BUS_HAS: sensors, SCENARIOS: [],
    });
    const prg = () => msg('READ_RES', 'PRG_THERMOSTATS', {
        RESULT: 'OK', PRG_THERMOSTATS: [{ ID: '1', DES: 'Room', PERIPH: { PID: '1' }, HEATING_OUT: '18', COOLING_OUT: 'NU' }],
    });
    const cfg = (entry) => msg('READ_RES', 'CFG_THERMOSTATS', { RESULT: 'OK', CFG_THERMOSTATS: [entry] });
    const rt = (model, val, { type = 'M', temp = '20.0', season = 'WIN' } = {}) => msg('REALTIME', 'CHANGES', {
        x: { STATUS_TEMPERATURES: [{ ID: '1', TEMP: temp, THERM: { ACT_SEA: season, ACT_MODEL: model, ACT_TOF: '', TEMP_THR: { T: type, VAL: val }, OUT_STATUS: 'OFF' } }] },
    });
    const system = (inside) => msg('REALTIME', 'CHANGES', { x: { STATUS_SYSTEM: [{ ID: '1', TEMP: { IN: inside, OUT: 'NA' } }] } });
    return { c, log, emits, msg, multi, prg, cfg, rt, system, device: () => c.state.devices.get('thermostat_18') };
}

test('TH-06 A: a re-login replays no stale cfg: no spurious heat -> off transition', () => {
    const h = client();
    h.multi(); h.prg(); h.cfg(realisticCfg('1', { mode: 'MAN', winTm: '21.0' })); h.rt('MAN', '21.0');
    h.rt('OFF', 'NA', { type: 'NA' });
    h.emits.length = 0;
    h.multi(); h.prg(); h.cfg(realisticCfg('1', { mode: 'OFF', winTm: '21.0' })); h.rt('OFF', 'NA', { type: 'NA' });
    assert.deepEqual(h.emits, []);
    assert.equal(h.device().status.mode, 'off');
});

test('TH-06 B: in AUTO the cfg manual setpoint never replaces the program target', () => {
    const h = client();
    const sequence = () => {
        h.multi(); h.prg(); h.cfg(realisticCfg('1', { mode: 'AUTO', winTm: '21.0' })); h.rt('AUTO', '18.0', { type: '1' });
    };
    sequence();
    assert.equal(h.device().status.targetTemperature, 18);
    h.emits.length = 0;
    sequence();
    assert.deepEqual(h.emits, []);
});

test('TH-06: before any realtime the first cfg read fills the state (first login)', () => {
    const h = client();
    h.multi(); h.prg(); h.cfg(realisticCfg('1', { mode: 'MAN', winTm: '22.5' }));
    assert.equal(h.device().status.mode, 'heat');
    assert.equal(h.device().status.targetTemperature, 22.5);
});

test('TH-03: a room sensor that stays silent is not replaced by the panel temperature', () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
        const h = client();
        h.multi(); h.prg(); h.rt('MAN', '21.0', { temp: '19.5' });
        h.emits.length = 0;
        now += 10 * 60 * 1000; // stable room, well past sensorFreshnessMs
        for (let i = 0; i < 5; i += 1) h.system('23.3');
        assert.equal(h.device().status.currentTemperature, 19.5);
        assert.deepEqual(h.emits, []);
    } finally {
        Date.now = realNow;
    }
});

test('TH-03: a thermostat with no source at all uses the panel temperature, one event per change', () => {
    const h = client();
    h.multi([]);
    h.system('23.3');
    h.system('23.3');
    h.system('23.5');
    assert.equal(h.device().status.currentTemperature, 23.5);
    assert.deepEqual(h.emits.map((e) => e.current), [23.3, 23.5]);
});

test('TH-16: an unknown realtime mode with a live setpoint is shown as heating, with one warning', () => {
    const h = client();
    h.multi(); h.prg();
    h.rt('OFF', 'NA', { type: 'NA' });
    h.rt('MAN_TMR', '22.0');
    h.rt('MAN_TMR', '22.5');
    assert.equal(h.device().status.mode, 'heat');
    assert.equal(h.device().status.targetTemperature, 22.5);
    const warnings = h.log.lines.warn.filter((line) => line.includes('ACT_MODEL'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /MAN_TMR/);
});

test('TH-16: an unknown realtime mode without a setpoint leaves the mode unchanged', () => {
    const h = client();
    h.multi(); h.prg();
    h.rt('MAN', '21.0');
    h.rt('WEEKLY', 'NA', { type: 'NA' });
    assert.equal(h.device().status.mode, 'heat');
});

test('TH-05 data for Matter: season and output role are on the thermostat status', () => {
    const h = client();
    h.multi(); h.prg(); h.rt('MAN', '26.0', { season: 'SUM' });
    assert.equal(h.device().status.season, 'SUM');
    assert.equal(h.device().status.outputRole, 'heating');
    assert.equal(typeof h.device().status.observedAt, 'number');
});

test('C contract: parseKseniaMode returns undefined for unknown values, kseniaModeToDomain keeps its legacy off', () => {
    const { parseKseniaMode, kseniaModeToDomain } = require('../dist/thermostat-mode.js');
    assert.equal(parseKseniaMode('MAN'), undefined);
    assert.equal(parseKseniaMode(undefined), undefined);
    assert.equal(parseKseniaMode(3), undefined);
    assert.equal(parseKseniaMode(' Heat '), 'heat');
    assert.equal(parseKseniaMode('0'), 'off');
    assert.equal(parseKseniaMode('automatico'), 'auto');
    assert.equal(kseniaModeToDomain('MAN'), 'off');
});

test('unreadable realtime values (NA, garbage) leave the thermostat state as it was', () => {
    const h = client();
    h.multi(); h.prg(); h.rt('MAN', '21.0', { temp: '19.5' });
    h.emits.length = 0;
    h.rt('MAN', 'x', { temp: 'NA' });
    assert.equal(h.device().status.currentTemperature, 19.5);
    assert.equal(h.device().status.targetTemperature, 21);
    assert.equal(h.device().status.mode, 'heat');
    h.cfg(realisticCfg('1', { mode: 'MAN', winTm: 'NA' }));
    assert.equal(h.device().status.targetTemperature, 21);
    h.system('NA');
    assert.equal(h.device().status.currentTemperature, 19.5);
});
