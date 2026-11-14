'use strict';

// TH-05 at the first login: the panel lists the outputs (MULTI_TYPES) before
// the thermostat programs (PRG_THERMOSTATS), so Matter registers a thermostat
// with the role its panel name suggests and learns the real one later. The
// endpoint must end with the attribute set of the program's role, without a
// restart, with one endpoint per output, its identity kept and no fallback;
// a panel that refuses PRG_THERMOSTATS keeps the name-based role and registers
// at once. Real WebSocket client state, real Homebridge/matter.js stack.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '2000';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '10';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '50';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '10';

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { signFrame } = require('./fixtures/panel-frame.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');
const { silentLog } = require('./fixtures/thermostat-panel');

// Output 18 heats, 34 cools; their panel names suggest the opposite of 18's role.
const OUTPUTS = [
    { ID: '18', DES: 'Raffrescamento prova', CAT: 'THERMO', MOD: 'C' },
    { ID: '34', DES: 'Uscita prova', CAT: 'THERMO', MOD: 'C' },
];
const PROGRAM = { ID: '1', DES: 'Prova', PERIPH: { PID: '1' }, HEATING_OUT: '18', COOLING_OUT: '34' };
const FALLBACK_FILE = 'klares4-matter-fallback.json';

async function firstLogin(t) {
    const stack = await realMatterStackSession(t).start();
    const storagePath = tmpStorage(t, 'klares4-role-reshape-');
    const lines = [];
    const at = (level) => (msg) => lines.push(`[${level}] ${msg}`);
    const log = { info: at('info'), warn: at('warn'), error: at('error'), debug() {}, success: at('info') };
    const registry = new MatterAccessoryRegistry({ api: stack.api, log, getWsClient: () => undefined, storagePath });
    registry.startDiscoveryCycle();

    // The platform wiring: discovery registers, status events update (device-event-router).
    const client = new KseniaWebSocketClient('127.0.0.1', 443, true, 'x', '000000', silentLog(), {});
    const work = [];
    client.onDeviceDiscovered = (device) => { work.push(registry.addOrUpdateAccessory(device)); };
    client.onDeviceStatusUpdate = (device) => { work.push(registry.updateAccessoryState(device)); };
    const msg = (CMD, PAYLOAD_TYPE, PAYLOAD) => client.messageService.handleMessage(signFrame({
        SENDER: 'p', RECEIVER: 'x', CMD, ID: '1', PAYLOAD_TYPE, PAYLOAD, TIMESTAMP: '0',
    }));
    const settled = async (ids) => {
        await Promise.all(work);
        await waitFor(() => ids.every((id) => registry.getStatus(id) === 'registered'), 10000);
    };
    return {
        stack, registry, lines, storagePath, settled,
        multi: () => msg('READ_RES', 'MULTI_TYPES', { RESULT: 'OK', OUTPUTS, BUS_HAS: [{ ID: '1', DES: 'Prova' }], SCENARIOS: [] }),
        programs: (program = PROGRAM) => msg('READ_RES', 'PRG_THERMOSTATS', { RESULT: 'OK', PRG_THERMOSTATS: [program] }),
        programsRefused: () => msg('READ_RES', 'PRG_THERMOSTATS', { RESULT: 'FAIL', RESULT_DETAIL: 'CMD_NOT_AVAILABLE' }),
        features: (id) => {
            const fm = stack.read(id, 'thermostat')?.featureMap ?? {};
            return { heating: fm.heating, cooling: fm.cooling, autoMode: fm.autoMode };
        },
        uniqueId: (id) => stack.read(id, 'bridgedDeviceBasicInformation')?.uniqueId,
    };
}

const HEATING_ONLY = { heating: true, cooling: false, autoMode: false };
const COOLING_ONLY = { heating: false, cooling: true, autoMode: false };
const BOTH = { heating: true, cooling: true, autoMode: true };

function assertClean(h) {
    const thermostats = [...h.stack.server.accessories.keys()].filter((id) => id.startsWith('thermostat_')).sort();
    assert.deepEqual(thermostats, ['thermostat_18', 'thermostat_34'], 'one endpoint per output');
    for (const id of ['thermostat_18', 'thermostat_34']) assert.equal(h.stack.deviceTypeName(id), 'Thermostat');
    assert.equal(fs.existsSync(path.join(h.storagePath, FALLBACK_FILE)), false, 'no fallback persisted');
    assert.equal(h.lines.some((l) => /TemperatureSensor/.test(l)), false, h.lines.join('\n'));
}

test('first login: MULTI_TYPES before PRG_THERMOSTATS ends with the program roles, identity kept, no restart', { timeout: 60000 }, async (t) => {
    const h = await firstLogin(t);
    h.multi();
    await h.settled(['thermostat_18', 'thermostat_34']);
    assert.deepEqual(h.features('thermostat_18'), BOTH, 'before the programs: the panel name suggests cooling');
    assert.deepEqual(h.features('thermostat_34'), HEATING_ONLY);
    const ids = { 18: h.uniqueId('thermostat_18'), 34: h.uniqueId('thermostat_34') };

    h.programs();
    await waitFor(() => h.features('thermostat_18').cooling === false && h.features('thermostat_34').cooling === true, 15000);
    await h.settled(['thermostat_18', 'thermostat_34']);
    assert.deepEqual(h.features('thermostat_18'), HEATING_ONLY);
    assert.deepEqual(h.features('thermostat_34'), COOLING_ONLY);
    // The identity is given back once the new endpoint answers.
    await waitFor(() => h.uniqueId('thermostat_18') === ids[18] && h.uniqueId('thermostat_34') === ids[34], 10000);
    assertClean(h);

    // The program changes on the panel at runtime: the roles swap.
    h.programs({ ...PROGRAM, HEATING_OUT: '34', COOLING_OUT: '18' });
    await waitFor(() => h.features('thermostat_18').cooling === true && h.features('thermostat_34').heating === true, 15000);
    await h.settled(['thermostat_18', 'thermostat_34']);
    assert.deepEqual(h.features('thermostat_18'), COOLING_ONLY);
    assert.deepEqual(h.features('thermostat_34'), HEATING_ONLY);
    assertClean(h);

    // The same programs again: nothing is replaced.
    const replacements = h.lines.filter((l) => /replacing the Thermostat endpoint/.test(l)).length;
    h.programs({ ...PROGRAM, HEATING_OUT: '34', COOLING_OUT: '18' });
    await h.settled(['thermostat_18', 'thermostat_34']);
    assert.equal(h.lines.filter((l) => /replacing the Thermostat endpoint/.test(l)).length, replacements);
});

test('first login on a panel that refuses PRG_THERMOSTATS: registered at once with the panel-name role, nothing replaced', { timeout: 60000 }, async (t) => {
    const h = await firstLogin(t);
    h.multi();
    h.programsRefused();
    await h.settled(['thermostat_18', 'thermostat_34']);
    assert.deepEqual(h.features('thermostat_18'), BOTH);
    assert.deepEqual(h.features('thermostat_34'), HEATING_ONLY);
    assert.equal(h.lines.some((l) => /replacing the Thermostat endpoint/.test(l)), false);
    assertClean(h);
});
