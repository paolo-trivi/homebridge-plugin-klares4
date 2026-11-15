'use strict';

// An MQTT scenario command runs the scenario only with active:true (mutation M50).

const test = require('node:test');
const assert = require('node:assert/strict');

const { CommandExecutor } = require('../dist/mqtt-bridge/command-executor.js');
const { waitFor } = require('./fixtures/wait-for.js');

const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });

test('an MQTT scenario command with active:false (or without active) does not run the scenario', async () => {
    const calls = [];
    const executor = new CommandExecutor({ log: silentLog(), findAccessory: () => ({ setOn: async (v) => { calls.push(v); } }) });
    executor.executeCommand('scenario', 'notte', JSON.stringify({ active: false }));
    executor.executeCommand('scenario', 'notte', JSON.stringify({}));
    executor.executeCommand('scenario', 'notte', JSON.stringify({ active: true }));
    await waitFor(() => calls.length > 0);
    assert.deepEqual(calls, [true], 'only the active:true command ran');
});
