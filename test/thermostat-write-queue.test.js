'use strict';

// TH-12, TH-11, TH-07 (ACK propagation), TH-17 / M19, TD-DOC-06.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createThermostatPanel, realisticCfg } = require('./fixtures/thermostat-panel');
const { ThermostatSeasonTracker } = require('../dist/websocket-client/thermostat-write-payload.js');
const { CommandService } = require('../dist/websocket-client/command-service.js');
const { CommandDispatcher } = require('../dist/websocket/command-dispatcher.js');
const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');

test('TH-12: a scene "Heat + 21" becomes one write, whatever the delivery order', async () => {
    for (const order of ['mode-first', 'setpoint-first']) {
        const sim = createThermostatPanel({
            thermostats: [{ out: '18', sensor: '1', cfg: '1' }],
            cfgs: [realisticCfg('1', { mode: 'OFF', season: 'SUM', winTm: '20.0', sumTm: '26.0' })],
            coalesceMs: 20,
        });
        sim.login();
        sim.realtime('1');
        const mode = () => sim.service.setThermostatMode('thermostat_18', 'heat');
        const setpoint = () => sim.service.setThermostatTemperature('thermostat_18', 21);
        await Promise.all(order === 'mode-first' ? [mode(), setpoint()] : [setpoint(), mode()]);
        assert.equal(sim.panel.writes.length, 1, order);
        const write = sim.panel.writes[0];
        assert.deepEqual(Object.keys(write), ['ID', 'ACT_MODE', 'ACT_SEA', 'WIN'], order);
        const panel = sim.panel.cfg.get('1');
        assert.deepEqual([panel.ACT_MODE, panel.ACT_SEA, panel.WIN.TM, panel.SUM.TM], ['MAN', 'WIN', '21.0', '26.0'], order);
    }
});

test('TH-12: two accessories sharing one cfg are serialized on that cfg, the latest values win', async () => {
    const sim = createThermostatPanel({
        thermostats: [{ out: '18', sensor: '1', cfg: '1' }, { out: '34', sensor: '1', cfg: '1' }],
        cfgs: [realisticCfg('1', { mode: 'OFF', season: 'WIN', winTm: '20.0' })],
        coalesceMs: 20,
    });
    sim.login();
    sim.realtime('1');
    await Promise.all([
        sim.service.setThermostatMode('thermostat_18', 'heat'),
        sim.service.setThermostatTemperature('thermostat_34', 22),
    ]);
    const panel = sim.panel.cfg.get('1');
    assert.deepEqual([panel.ACT_MODE, panel.WIN.TM], ['MAN', '22.0']);
    assert.equal(sim.panel.writes.length, 1);
});

test('TH-12: a command arriving while a write is in flight goes in the next write', async () => {
    const sim = createThermostatPanel({ thermostats: [{ out: '18', sensor: '1', cfg: '1' }], cfgs: [realisticCfg('1')] });
    sim.login();
    sim.realtime('1');
    const first = sim.service.setThermostatTemperature('thermostat_18', 21);
    const second = sim.service.setThermostatTemperature('thermostat_18', 22);
    const third = sim.service.setThermostatTemperature('thermostat_18', 23);
    await Promise.all([first, second, third]);
    assert.equal(sim.panel.cfg.get('1').WIN.TM, '23.0');
    assert.ok(sim.panel.writes.length <= 2);
});

test('TH-11: an acknowledged season never outlives a newer observation of the panel', () => {
    const tracker = new ThermostatSeasonTracker();
    tracker.recordAcknowledged('1', 'SUM', 10);
    assert.equal(tracker.resolve('1', [{ season: 'WIN', seq: 9 }]), 'SUM', 'ACK newer than the realtime');
    assert.equal(tracker.resolve('1', [{ season: 'WIN', seq: 11 }]), 'WIN', 'the panel spoke after the ACK');
    assert.equal(tracker.resolve('2', []), 'WIN');
});

test('TH-11: a "cool" never confirmed, then winter again on the panel: the setpoint goes to winter', async () => {
    const sim = createThermostatPanel({
        thermostats: [{ out: '18', sensor: '1', cfg: '1' }],
        cfgs: [realisticCfg('1', { mode: 'MAN', season: 'WIN' })],
        realtimeAfterWrite: false,
    });
    sim.login();
    sim.realtime('1');
    await sim.service.setThermostatMode('thermostat_18', 'cool');
    sim.panel.cfg.get('1').ACT_SEA = 'WIN'; // back to winter on the keypad, realtime unchanged (still WIN)
    sim.realtime('1');
    await sim.service.setThermostatTemperature('thermostat_18', 21);
    const panel = sim.panel.cfg.get('1');
    assert.deepEqual([panel.ACT_SEA, panel.WIN.TM, panel.SUM.TM], ['WIN', '21.0', '26.0']);
});

test('TH-07: an acknowledged write reaches the status channel at once (MAN setpoint, mode)', async () => {
    const sim = createThermostatPanel({
        thermostats: [{ out: '18', sensor: '1', cfg: '1' }],
        cfgs: [realisticCfg('1', { mode: 'MAN', winTm: '20.0' })],
        realtimeAfterWrite: false,
    });
    sim.login();
    sim.realtime('1');
    sim.emitted.length = 0;
    await sim.service.setThermostatTemperature('thermostat_18', 22);
    assert.deepEqual(sim.emitted, [{ id: 'thermostat_18', mode: 'heat', target: 22 }]);
    await sim.service.setThermostatMode('thermostat_18', 'off');
    assert.deepEqual(sim.emitted.at(-1), { id: 'thermostat_18', mode: 'off', target: 22 });
    const ack = sim.state.devices.get('thermostat_18').status.acknowledged;
    assert.equal(ack.mode, 'off');
    assert.equal(typeof ack.at, 'number');
});

test('TH-07: in AUTO an acknowledged setpoint is not shown as the live target; the real state is republished', async () => {
    const sim = createThermostatPanel({
        thermostats: [{ out: '18', sensor: '1', cfg: '1' }],
        cfgs: [realisticCfg('1', { mode: 'AUTO', winTm: '20.0' })],
        realtimeAfterWrite: false,
    });
    sim.login();
    sim.realtime('1');
    sim.emitted.length = 0;
    await sim.service.setThermostatTemperature('thermostat_18', 25);
    assert.deepEqual(sim.emitted, [{ id: 'thermostat_18', mode: 'auto', target: 20 }]);
    assert.ok(sim.log.lines.info.some((line) => /stored as the manual setpoint/.test(line)));
    assert.equal(sim.state.devices.get('thermostat_18').status.acknowledged.targetTemperature, 25);
});

test('TH-17 / M19: setpoints are validated and held to 5..40 before any write', async () => {
    const sim = createThermostatPanel({ thermostats: [{ out: '18', sensor: '1', cfg: '1' }], cfgs: [realisticCfg('1')] });
    sim.login();
    sim.realtime('1');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '22', undefined]) {
        await assert.rejects(() => sim.service.setThermostatTemperature('thermostat_18', bad), TypeError);
    }
    await assert.rejects(() => sim.service.setThermostatMode('thermostat_18', 'dry'), TypeError);
    assert.equal(sim.sent.length, 0);
    await sim.service.setThermostatTemperature('thermostat_18', 99);
    assert.equal(sim.panel.writes.at(-1).WIN.TM, '40.0');
    await sim.service.setThermostatTemperature('thermostat_18', 2);
    assert.equal(sim.panel.writes.at(-1).WIN.TM, '5.0');
});

test('TD-DOC-06: thermostat reads and writes wait commandTimeoutMs like every command', async () => {
    const state = createInitialWebSocketClientState();
    state.idLogin = '3';
    state.ws = { readyState: 1 };
    state.devices.set('thermostat_18', { id: 'thermostat_18', type: 'thermostat', status: { mode: 'off' } });
    state.thermostatProgramById.set('1', { ID: '1', HEATING_OUT: '18' });
    state.thermostatProgramIdByOutputId.set('18', '1');
    state.thermostatCfgById.set('1', realisticCfg('1'));
    const dispatcher = new CommandDispatcher();
    const timeouts = [];
    const register = dispatcher.registerPendingCommand.bind(dispatcher);
    dispatcher.registerPendingCommand = (id, timeoutMs, ...rest) => { timeouts.push(timeoutMs); return register(id, timeoutMs, ...rest); };
    const service = new CommandService({
        state, sender: 's', pin: '0000', log: { info() {}, warn() {}, error() {}, debug() {} }, logLevel: 1,
        options: { commandTimeoutMs: 4321 }, commandDispatcher: dispatcher,
        wsTransport: { send: async (_ws, raw) => {
            const frame = JSON.parse(raw);
            const answer = frame.CMD === 'READ'
                ? { CMD: 'READ_RES', PAYLOAD_TYPE: 'CFG_THERMOSTATS', PAYLOAD: { RESULT: 'OK' } }
                : { CMD: 'WRITE_CFG_RES', PAYLOAD_TYPE: 'CFG_ALL', PAYLOAD: { RESULT: 'OK', RESULT_DETAIL: 'WRITE_OK' } };
            if (frame.CMD === 'READ') state.thermostatCfgById.set('1', realisticCfg('1'));
            setImmediate(() => dispatcher.resolvePendingCommand({ ID: frame.ID, ...answer }));
        } },
        emitRawMessage: () => undefined,
    });
    await service.setThermostatTemperature('thermostat_18', 22);
    assert.deepEqual(timeouts, [4321, 4321]);
});

test('L4: a mode command arriving while the cfg is being re-read waits for that read: one READ', async () => {
    const sim = createThermostatPanel({ thermostats: [{ out: '18', sensor: '1', cfg: '1' }], cfgs: [realisticCfg('1', { mode: 'OFF' })] });
    sim.login();
    sim.realtime('1');
    let release;
    sim.panel.readGate = new Promise((resolve) => { release = resolve; });
    const setpoint = sim.service.setThermostatTemperature('thermostat_18', 22);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sim.panel.reads.length, 1, 'the setpoint re-read is in flight');
    const mode = sim.service.setThermostatMode('thermostat_18', 'heat');
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([setpoint, mode]);
    assert.equal(sim.panel.reads.length, 1);
    // The mode is routed once the read answers, after the setpoint was sealed: it follows in its own write.
    assert.deepEqual(sim.panel.writes.map((w) => Object.keys(w)), [['ID', 'WIN'], ['ID', 'ACT_MODE']]);
    const panel = sim.panel.cfg.get('1');
    assert.deepEqual([panel.ACT_MODE, panel.WIN.TM], ['MAN', '22.0']);
});

test('event order, not the clock: ACK and realtime in the same millisecond, both orders (frozen clock)', async (t) => {
    const frozen = Date.now();
    t.mock.method(Date, 'now', () => frozen);
    const scenario = async (realtimeAfterAck) => {
        const sim = createThermostatPanel({
            thermostats: [{ out: '18', sensor: '1', cfg: '1' }],
            cfgs: [realisticCfg('1', { mode: 'MAN', season: 'WIN' })],
            realtimeAfterWrite: false,
        });
        sim.login();
        sim.realtime('1'); // WIN, same millisecond as everything below
        await sim.service.setThermostatMode('thermostat_18', 'cool'); // ACK: SUM
        if (realtimeAfterAck) {
            sim.panel.cfg.get('1').ACT_SEA = 'WIN'; // the panel reports winter after the ACK
            sim.realtime('1');
        }
        await sim.service.setThermostatMode('thermostat_18', 'heat');
        return sim.panel.writes.at(-1);
    };
    // Realtime (WIN) then ACK (SUM): the ACK is newer, Heat must switch the season back.
    assert.deepEqual(await scenario(false), { ID: '1', ACT_MODE: 'MAN', ACT_SEA: 'WIN' });
    // ACK (SUM) then realtime (WIN): the realtime is newer, the panel is already in winter.
    assert.deepEqual(await scenario(true), { ID: '1', ACT_MODE: 'MAN' });
});

test('ThermostatSeasonTracker orders by event sequence: no ties', () => {
    const tracker = new ThermostatSeasonTracker();
    tracker.recordAcknowledged('1', 'SUM', 5);
    assert.equal(tracker.resolve('1', [{ season: 'WIN', seq: 4 }]), 'SUM');
    assert.equal(tracker.resolve('1', [{ season: 'WIN', seq: 6 }]), 'WIN');
});
