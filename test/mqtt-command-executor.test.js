const test = require('node:test');
const assert = require('node:assert/strict');

const { CommandExecutor } = require('../dist/mqtt-bridge/command-executor.js');

function createHarness({ failMode = false } = {}) {
    const events = [];
    const errors = [];
    let modeDone;
    const modeSettled = new Promise((resolve) => { modeDone = resolve; });
    const accessory = {
        setTargetHeatingCoolingState: async (value) => {
            events.push(`mode:start:${value}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
            events.push('mode:end');
            modeDone();
            if (failMode) throw new Error('WRITE_CFG_RES RESULT=FAIL');
        },
        setTargetTemperature: async (value) => {
            events.push(`temp:start:${value}`);
        },
    };
    const executor = new CommandExecutor({
        log: { info() {}, warn() {}, debug() {}, error: (...args) => errors.push(args.join(' ')) },
        findAccessory: () => accessory,
    });
    return { executor, events, errors, modeSettled };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test('MQTT thermostat command with mode and setpoint writes the mode first, then the setpoint', async () => {
    const h = createHarness();
    h.executor.executeCommand('thermostat', 'sala', JSON.stringify({ targetTemperature: 24, mode: 'cool' }));
    await h.modeSettled;
    await settle();
    // HomeKit TargetHeatingCoolingState COOL = 2.
    assert.deepEqual(h.events, ['mode:start:2', 'mode:end', 'temp:start:24']);
});

test('MQTT thermostat setpoint is not written when the mode change in the same command failed', async () => {
    const h = createHarness({ failMode: true });
    h.executor.executeCommand('thermostat', 'sala', JSON.stringify({ targetTemperature: 24, mode: 'cool' }));
    await h.modeSettled;
    await settle();
    assert.deepEqual(h.events, ['mode:start:2', 'mode:end']);
    assert.ok(h.errors.some((line) => line.includes('mode')));
});

test('MQTT thermostat setpoint alone is still written', async () => {
    const h = createHarness();
    h.executor.executeCommand('thermostat', 'sala', JSON.stringify({ targetTemperature: 21.5 }));
    await settle();
    assert.deepEqual(h.events, ['temp:start:21.5']);
});
