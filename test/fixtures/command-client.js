'use strict';

// A logged-in KseniaWebSocketClient whose socket writes are captured instead of
// sent. Devices are seeded the way discovery stores them, so commands reach the
// same checks they meet in production. All IDs and names are synthetic.

const { KseniaWebSocketClient } = require('../../dist/websocket-client/index.js');

const SYNTHETIC_PIN = '135790';

const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });

function recordingLog() {
    const lines = [];
    const push = (level) => (...a) => lines.push([level, a.map(String).join(' ')]);
    return { lines, log: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug'), success: push('info') } };
}

const STATUS_BY_TYPE = {
    light: () => ({ on: false, brightness: 0, dimmable: true }),
    cover: () => ({ position: 0, targetPosition: 0, state: 'stopped' }),
    gate: () => ({ on: false }),
    scenario: () => ({ active: false }),
};

/** Stores `ids` (e.g. `light_12`, `scenario_3`) in a client state as discovered devices. */
function seedStateDevices(state, ids) {
    for (const id of ids) {
        const [type, systemId] = id.split('_');
        state.devices.set(id, { id, type, name: `Device ${systemId}`, description: '', status: STATUS_BY_TYPE[type]() });
        if (type === 'scenario') state.scenarioCategoryById.set(systemId, 'GEN');
    }
}

function seedDevices(client, ids) {
    seedStateDevices(client['state'], ids);
}

/**
 * `reply(message, client)`: called for each frame written; the default answers
 * every CMD_USR with RESULT OK on the next tick. Return nothing to stay silent.
 */
function commandClient({
    devices = [],
    pin = SYNTHETIC_PIN,
    log = silentLog(),
    options = {},
    reply = (message, client) => setImmediate(() => client['commandDispatcher'].resolvePendingCommand({
        ID: message.ID, CMD: 'CMD_USR_RES', PAYLOAD_TYPE: 'REPLY', PAYLOAD: { RESULT: 'OK', RESULT_DETAIL: 'CMD_PROCESSED' },
    })),
} = {}) {
    const client = new KseniaWebSocketClient('127.0.0.1', 1, false, 'hb', pin, log, { commandTimeoutMs: 200, ...options });
    client['state'].idLogin = '77';
    client['state'].ws = { readyState: 1 };
    seedDevices(client, devices);
    const sent = [];
    client['wsTransport'].send = async (_ws, raw) => {
        const m = JSON.parse(raw);
        sent.push({ raw, m });
        if (m.CMD === 'CMD_USR') reply(m, client);
    };
    return { client, sent };
}

/** Feeds STATUS_OUTPUTS entries through the client's real status path. */
function pushOutputStatus(client, ...statuses) {
    client['statusUpdater'].updateOutputStatuses(statuses);
}

const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

module.exports = { SYNTHETIC_PIN, commandClient, seedDevices, seedStateDevices, pushOutputStatus, recordingLog, silentLog, settle };
