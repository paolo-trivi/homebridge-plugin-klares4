'use strict';

// WS-08: non-finite numbers and wrong types are refused at the last level.
// WS-01 (defense in depth): a command reaches only a discovered output of that
// kind. M58 / command-outcome: a mutation needs RESULT=OK, and "sent without
// confirmation" is a failure, never a success.

const test = require('node:test');
const assert = require('node:assert/strict');

const { ValidationKlaresError, RetryableKlaresError } = require('../dist/errors.js');
const { reportMutationOutcome } = require('../dist/websocket-client/command-outcome.js');
const { commandClient, settle } = require('./fixtures/command-client.js');

const BAD_NUMBERS = [NaN, undefined, 'abc', Infinity, -Infinity, null, '70', true, {}];

test('repro 12: moveCover and dimLight refuse values that are not finite numbers, nothing is sent', async () => {
    const { client, sent } = commandClient({ devices: ['cover_7', 'light_5'] });
    for (const value of BAD_NUMBERS) {
        for (const call of [() => client.moveCover('cover_7', value), () => client.dimLight('light_5', value)]) {
            const result = await settle(call());
            assert.equal(result.ok, false, `accepted ${String(value)}`);
            assert.ok(result.error instanceof ValidationKlaresError, String(result.error));
        }
    }
    assert.equal(sent.length, 0);
});

test('switchLight refuses anything but a boolean ("false" used to switch the light ON)', async () => {
    const { client, sent } = commandClient({ devices: ['light_5'] });
    for (const value of ['false', 'true', 0, 1, undefined, null]) {
        const result = await settle(client.switchLight('light_5', value));
        assert.ok(result.error instanceof ValidationKlaresError, `accepted ${String(value)}`);
    }
    assert.equal(sent.length, 0);
});

test('a command to an output that is not a discovered device of that kind is refused', async () => {
    const { client, sent } = commandClient({ devices: ['light_5', 'cover_7', 'gate_9', 'scenario_1'] });
    const refused = [
        () => client.switchLight('light_99', true),
        () => client.dimLight('light_99', 50),
        () => client.switchLight('cover_7', true),
        () => client.switchLight('7', true),
        () => client.moveCover('light_5', 50),
        () => client.toggleGate('light_5'),
        () => client.toggleGate('gate_10'),
        () => client.triggerScenario('scenario_2'),
    ];
    for (const call of refused) {
        const result = await settle(call());
        assert.equal(result.ok, false);
        assert.ok(result.error instanceof ValidationKlaresError, String(result.error));
    }
    assert.equal(sent.length, 0);
    await client.switchLight('5', true);
    await client.switchLight('light_5', false);
    await client.moveCover('cover_7', 50);
    await client.toggleGate('gate_9');
    await client.triggerScenario('scenario_1');
    assert.equal(sent.length, 5);
});

test('an arming scenario stays refused even when it is a discovered device', async () => {
    const { client, sent } = commandClient({ devices: ['scenario_2'] });
    client['state'].scenarioCategoryById.set('2', 'ARM');
    await assert.rejects(client.triggerScenario('scenario_2'), /arms or disarms/);
    assert.equal(sent.length, 0);
});

test('a scenario of unknown category is refused for what it is, and runs once listed in exposeScenarios', async () => {
    for (const exposeScenarios of [undefined, [{ scenarioId: '4' }]]) {
        const { client, sent } = commandClient({ devices: ['scenario_3'], options: { exposeScenarios } });
        client['state'].scenarioCategoryById.set('3', 'ARM_AWAY');
        await assert.rejects(client.triggerScenario('scenario_3'), (error) => error instanceof ValidationKlaresError
            && /not a known harmless one/.test(error.message) && !/arms or disarms/.test(error.message));
        assert.equal(sent.length, 0);
    }
    const { client, sent } = commandClient({ devices: ['scenario_3'], options: { exposeScenarios: [{ scenarioId: '3' }] } });
    client['state'].scenarioCategoryById.set('3', 'ARM_AWAY');
    await client.triggerScenario('scenario_3');
    assert.deepEqual(sent.map((s) => s.m.PAYLOAD.SCENARIO), [{ ID: '3' }]);
    // ARM never runs, opt-in or not.
    const armed = commandClient({ devices: ['scenario_2'], options: { exposeScenarios: [{ scenarioId: '2' }] } });
    armed.client['state'].scenarioCategoryById.set('2', 'ARM');
    await assert.rejects(armed.client.triggerScenario('scenario_2'), /arms or disarms/);
    assert.equal(armed.sent.length, 0);
});

test('COMMS-10: a scenario with a harmless category that is not a discovered device is refused, nothing sent', async () => {
    const { client, sent } = commandClient({ devices: ['scenario_1'] });
    // Listed earlier as GEN, no longer a discovered device (removed on the panel).
    client['state'].scenarioCategoryById.set('5', 'GEN');
    await assert.rejects(client.triggerScenario('scenario_5'), (error) => error instanceof ValidationKlaresError
        && /not a scenario discovered on the panel/.test(error.message));
    assert.equal(sent.length, 0);
});

test('M58: a CMD_USR_RES without RESULT does not acknowledge a mutation', async () => {
    const { client } = commandClient({
        devices: ['gate_9', 'light_5'],
        options: { commandTimeoutMs: 5000 },
        reply: (message, c) => setImmediate(() => c['commandDispatcher'].resolvePendingCommand({
            ID: message.ID, CMD: 'CMD_USR_RES', PAYLOAD_TYPE: 'REPLY', PAYLOAD: {},
        })),
    });
    await assert.rejects(client.toggleGate('gate_9'), /did not contain RESULT=OK/);
    await assert.rejects(client.switchLight('light_5', true), /did not contain RESULT=OK/);
});

test('M58: the sender requires a positive result for CMD_USR and WRITE_CFG whatever the caller asks', async () => {
    const { client } = commandClient({
        options: { commandTimeoutMs: 5000 },
        reply: (message, c) => setImmediate(() => c['commandDispatcher'].resolvePendingCommand({
            ID: message.ID, CMD: 'CMD_USR_RES', PAYLOAD_TYPE: 'REPLY', PAYLOAD: {},
        })),
    });
    const send = (cmd, options) => client['commandService'].sendKseniaCommand(cmd, 'CMD_SET_OUTPUT', { ID_LOGIN: 'true', PIN: 'true', OUTPUT: { ID: '5', STA: 'ON' } }, options);
    await assert.rejects(send('CMD_USR', { awaitResponse: true, responseCmds: ['CMD_USR_RES'] }), /did not contain RESULT=OK/);
    await assert.rejects(send('CMD_USR', {}), (error) => error instanceof RetryableKlaresError);
});

test('"sent without confirmation" is an error, not a logged success', () => {
    const lines = [];
    const log = { info: (l) => lines.push(l), warn: (l) => lines.push(l), error() {}, debug() {} };
    assert.throws(() => reportMutationOutcome(log, 'Light', '5', 'ON', undefined), /without confirmation/);
    assert.deepEqual(lines, []);
    reportMutationOutcome(log, 'Light', '5', 'ON', { status: 'acknowledged', latencyMs: 3 });
    assert.equal(lines.length, 1);
});
