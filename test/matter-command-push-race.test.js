'use strict';

// A controller command and a state push of the plugin on the same endpoint,
// on the real Homebridge/matter.js stack. Homebridge runs the plugin's handler
// and then matter.js's own command, which needs the endpoint's state lock
// synchronously; a push applied in its own transaction at that moment made the
// command fail towards the controller ("Cannot lock … synchronously") although
// the panel had done it. Also: a state queued before a command must not put a
// value the panel has since acknowledged back on the endpoint.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '5000';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '10';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '50';

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { markStatusObserved } = require('../dist/device-observation.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const SLOW = { timeout: 120000 };

function panel() {
    const calls = [];
    const ack = (op) => async (id, value) => { calls.push([op, value]); };
    return {
        calls,
        switchLight: ack('switch'), dimLight: ack('dim'), moveCover: ack('cover'),
        setThermostatTemperature: ack('temp'), setThermostatMode: ack('mode'),
    };
}

async function boot(t) {
    const stack = await realMatterStackSession(t).start();
    const ws = panel();
    const lines = [];
    const at = (level) => (msg) => lines.push(`[${level}] ${msg}`);
    const registry = new MatterAccessoryRegistry({
        api: stack.api, log: { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') },
        getWsClient: () => ws, storagePath: tmpStorage(t, 'klares4-push-race-'),
    });
    registry.startDiscoveryCycle();
    /** Registers and returns at once: the first state push is still on its way, as on a real bridge. */
    const add = async (device) => {
        markStatusObserved(device);
        await registry.addOrUpdateAccessory(device);
        await waitFor(() => registry.getStatus(device.id) === 'registered', 60000);
    };
    return { stack, registry, ws, lines, add };
}

const commandOk = (promise) => promise.then(() => 'ok', (err) => `ERR ${err.message}`);

test('thermostat: two +1 °C right after registration both succeed, and the queued first state does not undo the first', SLOW, async (t) => {
    const b = await boot(t);
    const status = { currentTemperature: 20.5, targetTemperature: 21, mode: 'heat', outputRole: 'heating' };
    await b.add({ id: 'thermostat_1', type: 'thermostat', name: 'Termostato prova', description: '', currentTemperature: 20.5, targetTemperature: 21, mode: 'heat', status });
    const first = await commandOk(b.stack.invoke('thermostat_1', 'thermostat', 'setpointRaiseLower', { mode: 0, amount: 10 }));
    const second = await commandOk(b.stack.invoke('thermostat_1', 'thermostat', 'setpointRaiseLower', { mode: 0, amount: 10 }));
    assert.deepEqual([first, second], ['ok', 'ok']);
    assert.deepEqual(b.ws.calls, [['temp', 22], ['temp', 23]], 'no stale 21 °C came back as a command');
    await b.stack.until(() => b.stack.read('thermostat_1', 'thermostat')?.occupiedHeatingSetpoint === 2300, 'setpoint 23 °C');
});

for (const kind of ['light', 'dimmer', 'cover']) {
    test(`${kind}: a command while a state push is being applied succeeds`, SLOW, async (t) => {
        const b = await boot(t);
        const device = {
            light: { id: 'light_2', type: 'light', name: 'Luce prova', description: '', status: { on: false, dimmable: false } },
            dimmer: { id: 'light_3', type: 'light', name: 'Faretto prova', description: '', status: { on: true, dimmable: true, brightness: 40 } },
            cover: { id: 'cover_4', type: 'cover', name: 'Tapparella prova', description: '', status: { position: 30, targetPosition: 30, state: 'stopped' } },
        }[kind];
        await b.add(device);
        const command = {
            light: ['onOff', 'on', {}],
            dimmer: ['levelControl', 'moveToLevel', { level: 200, transitionTime: null, optionsMask: {}, optionsOverride: {} }],
            cover: ['windowCovering', 'goToLiftPercentage', { liftPercent100thsValue: 2500 }],
        }[kind];
        const results = [];
        for (let i = 0; i < 5; i += 1) {
            // A realtime from the panel, then at once a controller command.
            const update = kind === 'cover'
                ? { ...device, status: { ...device.status, position: 30 + i } }
                : kind === 'dimmer' ? { ...device, status: { ...device.status, brightness: 40 + i } } : { ...device, status: { ...device.status, on: i % 2 === 1 } };
            markStatusObserved(update);
            await b.registry.updateAccessoryState(update);
            results.push(await commandOk(b.stack.invoke(device.id, ...command)));
        }
        assert.deepEqual(results, ['ok', 'ok', 'ok', 'ok', 'ok']);
        assert.equal(b.ws.calls.length, 5);
    });
}
