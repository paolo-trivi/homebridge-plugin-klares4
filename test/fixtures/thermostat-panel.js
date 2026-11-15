'use strict';

/**
 * A panel model for thermostat cfg commands, wired to the real client classes
 * (ThermostatCommandService, ThermostatReadHandler, ThermostatStatusUpdater,
 * CommandDispatcher). The cfg has the real CFG_THERMOSTATS shape; every value
 * and name is synthetic.
 *
 * Write semantics: each top-level key of a WRITE_CFG entry replaces the
 * panel's key, a season block included (the most destructive reading of a
 * partial write: a block with TM alone would wipe the schedule). Every write,
 * and every change made "on the keypad", bumps PRG_CHECK.CFG like the panel.
 */
const { CommandDispatcher } = require('../../dist/websocket/command-dispatcher.js');
const { createInitialWebSocketClientState } = require('../../dist/websocket-client/state.js');
const { ThermostatCommandService } = require('../../dist/websocket-client/thermostat-command-service.js');
const { ThermostatReadHandler } = require('../../dist/websocket-client/thermostat-read-handler.js');
const { ThermostatStatusUpdater } = require('../../dist/websocket-client/thermostat-status-updater.js');

const day = () => [{ T: '0', S: '1' }, { T: '6.5', S: '2' }, { T: '22', S: '1' }];
const seasonBlock = (tm) => ({
    T1: '18.0', T2: '20.0', T3: '21.5', TM: tm,
    MON: day(), TUE: day(), WED: day(), THU: day(), FRI: day(), SAT: day(), SUN: day(), SD1: day(), SD2: day(),
});

function realisticCfg(id, { mode = 'MAN', season = 'WIN', winTm = '20.0', sumTm = '26.0' } = {}) {
    return { ID: id, ACT_MODE: mode, ACT_SEA: season, MAN_HRS: 'NA', WIN: seasonBlock(winTm), SUM: seasonBlock(sumTm), TOF: { T: '5.0', E: 'F' } };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function silentLog() {
    const lines = { info: [], warn: [], error: [], debug: [] };
    const log = {};
    for (const level of Object.keys(lines)) log[level] = (...args) => lines[level].push(args.join(' '));
    log.lines = lines;
    return log;
}

/**
 * thermostats: [{ out, sensor?, cfg? }]; cfgs: realisticCfg(...)[].
 * programs: PRG_THERMOSTATS known (cfg ids from `cfg`); false = degraded install.
 */
function createThermostatPanel({
    thermostats,
    cfgs,
    programs = true,
    manualCommandPairs = [],
    readFails = false,
    emit = true,
    coalesceMs = 0,
    realtimeAfterWrite = true,
} = {}) {
    const state = createInitialWebSocketClientState({ manualCommandPairs });
    state.idLogin = '1';
    const panel = { cfg: new Map(cfgs.map((c) => [c.ID, clone(c)])), writes: [], reads: [], counter: 1000, readFails, writeFails: false, readGate: undefined };
    const log = silentLog();
    const emitted = [];
    const emitDeviceStatusUpdate = (device) => emitted.push({
        id: device.id, mode: device.status.mode, target: device.status.targetTemperature,
    });
    for (const t of thermostats) {
        const status = { currentTemperature: 20, targetTemperature: 21, mode: 'off' };
        state.devices.set(`thermostat_${t.out}`, {
            id: `thermostat_${t.out}`, type: 'thermostat', name: `Thermostat ${t.out}`, description: '',
            status, currentTemperature: 20, targetTemperature: 21, mode: 'off',
        });
        if (t.sensor) state.thermostatToDomus.set(t.out, t.sensor);
        if (programs && t.cfg) {
            state.thermostatProgramById.set(t.cfg, { ID: t.cfg, PERIPH: { PID: t.sensor }, HEATING_OUT: t.out });
            state.thermostatProgramIdByOutputId.set(t.out, t.cfg);
            if (t.sensor) state.domusSensorIdByThermostatProgramId.set(t.cfg, t.sensor);
        }
    }
    const updater = new ThermostatStatusUpdater({ state, emitDeviceStatusUpdate, log });
    const reader = new ThermostatReadHandler({
        state, log, logLevel: 1, thermostatStatusUpdater: updater, emitDeviceStatusUpdate,
    });
    const prgCheck = () => ({ PRG: '0000000001', CFG: String(panel.counter).padStart(10, '0') });
    const dispatcher = new CommandDispatcher();
    const sent = [];

    /** STATUS_TEMPERATURES for a cfg, keyed by its DOMUS sensor id as the panel does. */
    const realtime = (cfgId, { temp = '20.0' } = {}) => {
        const c = panel.cfg.get(cfgId);
        const sensor = thermostats.find((t) => (t.cfg ?? t.sensor) === cfgId)?.sensor ?? cfgId;
        const off = c.ACT_MODE === 'OFF';
        updater.updateTemperatureStatuses([{
            ID: sensor, TEMP: temp,
            THERM: {
                ACT_SEA: c.ACT_SEA, ACT_MODEL: c.ACT_MODE, ACT_TOF: '',
                TEMP_THR: off ? { T: 'NA', VAL: 'NA' } : { T: 'M', VAL: c[c.ACT_SEA].TM },
                OUT_STATUS: 'OFF',
            },
        }]);
    };

    const send = async (cmd, payloadType, payload, options) => {
        sent.push({ cmd, payloadType, payload: clone(payload), options });
        if (cmd === 'READ' && payloadType === 'CFG_THERMOSTATS') {
            panel.reads.push(payload.ID_READ);
            if (panel.readGate) await panel.readGate;
            if (panel.readFails) throw new Error('Command timed out');
            const all = payload.ID_READ === 'ALL';
            const c = panel.cfg.get(payload.ID_READ);
            reader.handleCfgThermostats(all ? [...panel.cfg.values()].map(clone) : (c ? [clone(c)] : []), prgCheck());
            return undefined;
        }
        if (cmd === 'WRITE_CFG') {
            const entry = clone(payload.CFG_THERMOSTATS[0]);
            if (panel.writeFails) throw new Error('WRITE_CFG_RES RESULT=FAIL');
            panel.writes.push(entry);
            const current = panel.cfg.get(entry.ID);
            if (!current) throw new Error('WRITE_CFG_RES RESULT=FAIL');
            for (const [key, value] of Object.entries(entry)) current[key] = value;
            panel.counter += 1;
            if (realtimeAfterWrite) realtime(entry.ID);
            return { status: 'acknowledged' };
        }
        throw new Error(`unexpected ${cmd}`);
    };

    const service = new ThermostatCommandService({
        state, log, logLevel: 1, commandDispatcher: dispatcher, send,
        emitDeviceStatusUpdate: emit ? emitDeviceStatusUpdate : undefined,
        writeCoalesceMs: coalesceMs,
    });

    /** The login READ_RES CFG_THERMOSTATS (ALL). */
    const login = () => reader.handleCfgThermostats([...panel.cfg.values()].map(clone), prgCheck());
    /** A change made on the keypad: realtime follows, and NM_CHANGES unless `notify` is false. */
    const keypad = (cfgId, mutate, { notify = true } = {}) => {
        mutate(panel.cfg.get(cfgId));
        panel.counter += 1;
        realtime(cfgId);
        if (notify) reader.handleChangeNotification({ PRG_CHECK: prgCheck() });
    };
    const notifyChanges = () => reader.handleChangeNotification({ PRG_CHECK: prgCheck() });

    return { state, service, reader, updater, panel, sent, log, emitted, login, realtime, keypad, notifyChanges };
}

/** Every leaf path whose value differs between two objects. */
function deepDiff(before, after, prefix = '') {
    const diffs = [];
    if (before && typeof before === 'object') {
        for (const key of new Set([...Object.keys(before), ...Object.keys(after ?? {})])) {
            diffs.push(...deepDiff(before[key], after?.[key], prefix ? `${prefix}.${key}` : key));
        }
    } else if (before !== after) {
        diffs.push(prefix);
    }
    return diffs;
}

module.exports = { createThermostatPanel, realisticCfg, clone, deepDiff, silentLog };
