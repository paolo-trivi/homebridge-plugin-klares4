'use strict';

// WS-05: the RESULT of the realtime registration and of the discovery reads
// is checked. A refusal is logged at warn, the sync is not declared complete
// and the session goes back to the reconnection backoff; the PRG_THERMOSTATS
// CMD_NOT_AVAILABLE answer the panel gives at every login is not a failure.

const test = require('node:test');
const assert = require('node:assert/strict');

const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { startMockPanel, recordingLog, frame } = require('./fixtures/lares4-mock-panel.js');
const { waitFor } = require('./fixtures/wait-for.js');

async function session(t, panelOptions = {}, options = {}) {
    const panel = await startMockPanel(panelOptions);
    const log = recordingLog();
    const client = new KseniaWebSocketClient('127.0.0.1', panel.port, false, 'hb', '135790', log, {
        heartbeatInterval: 60_000, reconnectInterval: 20, ...options,
    });
    const events = [];
    client.onInitialSyncComplete = () => events.push('sync');
    client.onDisconnected = () => events.push('disconnected');
    t.after(async () => {
        client.disconnect();
        await panel.close();
    });
    return { panel, log, client, events };
}

const warnings = (log) => log.lines.filter((l) => l.startsWith('[warn]'));

test('WS-05 A: a refused realtime registration is not a completed sync; the session reconnects', async (t) => {
    const { panel, log, client, events } = await session(t, {
        onMessage: (m, socket, mock) => {
            if (m.CMD !== 'REALTIME' || mock.logins > 2) return false;
            socket.send(frame('REALTIME_RES', m.ID, 'REGISTER_ACK', { RESULT: 'FAIL', RESULT_DETAIL: 'CMD_NOT_AVAILABLE' }));
            return true;
        },
    });
    await client.connect();
    await waitFor(() => events.includes('sync'));
    assert.equal(panel.logins, 3, 'two refused registrations, then a session that completes');
    assert.equal(events.filter((e) => e === 'sync').length, 1);
    assert.ok(events.indexOf('disconnected') < events.indexOf('sync'));
    assert.equal(warnings(log).filter((l) => /refused the realtime registration \(CMD_NOT_AVAILABLE\)/.test(l)).length, 2);
});

test('WS-05 B: an occasional refused discovery read is not a completed sync and keeps backing off', async (t) => {
    const { panel, log, client, events } = await session(t, {
        // Refused at the first two logins only (panel busy).
        onMessage: (m, socket, mock) => {
            if (m.CMD !== 'READ' || m.PAYLOAD_TYPE !== 'MULTI_TYPES' || mock.logins > 2) return false;
            socket.send(frame('READ_RES', m.ID, 'MULTI_TYPES', { RESULT: 'FAIL', RESULT_DETAIL: 'CMD_NOT_AVAILABLE' }));
            return true;
        },
    });
    let attemptsAtSecondRefusal;
    client.onDisconnected = () => {
        events.push('disconnected');
        if (panel.logins === 2) attemptsAtSecondRefusal = client['state'].reconnectAttempts;
    };
    await client.connect();
    await waitFor(() => events.includes('sync'));
    assert.equal(panel.logins, 3);
    assert.equal(events.filter((e) => e === 'sync').length, 1);
    assert.equal(warnings(log).filter((l) => /refused the MULTI_TYPES read \(CMD_NOT_AVAILABLE\): the synchronization is not complete/.test(l)).length, 2);
    // A login that ends in a refused sync does not reset the backoff.
    assert.equal(attemptsAtSecondRefusal, 1);
    assert.equal(client['state'].reconnectAttempts, 0, 'a completed sync resets the backoff');
    assert.ok(client.getAllDevices().some((d) => d.id === 'light_5'), 'the full sync discovered the outputs');
});

test('COMMS-02: a discovery read always refused ends in a degraded sync that serves the other families', async (t) => {
    const { panel, log, client, events } = await session(t, { failReads: ['ZONES'] });
    await client.connect();
    await waitFor(() => events.includes('sync'));
    assert.equal(panel.logins, 3, 'two refused syncs, then the degraded one');
    const ids = client.getAllDevices().map((d) => d.id);
    assert.ok(ids.includes('light_5') && ids.includes('scenario_1'), 'outputs and scenarios are discovered');
    assert.ok(!ids.includes('zone_1'));
    assert.equal(warnings(log).filter((l) => /refused the ZONES read .* in 3 synchronizations in a row: continuing without it/.test(l)).length, 1);

    // Further degraded syncs: no reconnection loop, no repeated warning.
    for (let i = 0; i < 3; i += 1) {
        const synced = events.filter((e) => e === 'sync').length;
        panel.dropConnections();
        await waitFor(() => events.filter((e) => e === 'sync').length === synced + 1);
    }
    assert.equal(panel.logins, 6);
    assert.equal(warnings(log).filter((l) => /refused the ZONES read/.test(l)).length, 3);

    // The read answers again: zones are back and the streak is over.
    panel.failReads.delete('ZONES');
    panel.dropConnections();
    await waitFor(() => client.getAllDevices().some((d) => d.id === 'zone_1'));
    assert.equal(client['state'].refusedDiscoveryReads.size, 0);
});

test('WS-05 C: PRG_THERMOSTATS CMD_NOT_AVAILABLE is normal; a refused status read is reported and tolerated', async (t) => {
    const { log, client, events } = await session(t, { failReads: ['STATUS_SYSTEM'] });
    await client.connect();
    await waitFor(() => events.includes('sync'));
    assert.ok(!warnings(log).some((l) => /PRG_THERMOSTATS/.test(l)), warnings(log).join('\n'));
    assert.ok(warnings(log).some((l) => /refused the STATUS_SYSTEM read .*continues/.test(l)));
    assert.ok(!events.includes('disconnected'));
});

test('WS-05 D: a panel that never answers the realtime registration is reconnected after the sync timeout', async (t) => {
    const { panel, log, client, events } = await session(t, {
        onMessage: (m, _socket, mock) => m.CMD === 'REALTIME' && mock.logins === 1,
    }, { syncTimeoutMs: 150 });
    await client.connect();
    await waitFor(() => events.includes('sync'));
    assert.equal(panel.logins, 2);
    assert.ok(warnings(log).some((l) => /did not complete the synchronization within/.test(l)));
});
