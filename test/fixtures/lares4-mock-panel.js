'use strict';

// Mock Lares4 panel on 127.0.0.1 (ephemeral port) speaking the subset of the
// protocol the plugin uses: LOGIN, the discovery/status READs, REALTIME
// REGISTER and CMD_USR. All names are synthetic.

const { WebSocketServer } = require('ws');

function frame(cmd, id, payloadType, payload) {
    return JSON.stringify({
        SENDER: 'panel', RECEIVER: '', CMD: cmd, ID: id, PAYLOAD_TYPE: payloadType, PAYLOAD: payload,
        TIMESTAMP: '0', CRC_16: '0x0000',
    });
}

const DEFAULT_DATA = {
    ZONES: [{ ID: '1', DES: 'Zone One' }],
    OUTPUTS: [
        { ID: '5', DES: 'Light A', CAT: 'LIGHT', MOD: 'B' },
        { ID: '6', DES: 'Light B', CAT: 'LIGHT', MOD: 'B' },
        { ID: '7', DES: 'Shutter', CAT: 'ROLL', MOD: 'BDP' },
        { ID: '9', DES: 'Gate', CAT: 'GATE', MOD: 'M' },
    ],
    SCENARIOS: [
        { ID: '1', DES: 'Evening', CAT: 'GEN', PIN: 'N' },
        { ID: '2', DES: 'Arm', CAT: 'ARM', PIN: 'N' },
    ],
    BUS_HAS: [{ ID: '1', DES: 'Domus One' }],
    STATUS_OUTPUTS: [
        { ID: '5', STA: 'OFF' }, { ID: '6', STA: 'OFF' },
        { ID: '7', STA: 'CLOSE', POS: '0', TPOS: '0' }, { ID: '9', STA: 'OFF' },
    ],
    STATUS_BUS_HA_SENSORS: [{ ID: '1', DOMUS: { TEM: '21.5', HUM: '45', LHT: '120' } }],
    STATUS_ZONES: [{ ID: '1', STA: 'R', BYP: 'NO', A: 'N', FM: 'F' }],
    STATUS_SYSTEM: [{ ID: '1', TEMP: { IN: '22.0', OUT: '10.0' } }],
};

/**
 * `failReads`: READ payload types answered with RESULT FAIL (a partial sync).
 * `onMessage(message, socket, panel)` may return true to suppress the reply.
 * `panel.data` can be changed between sessions; it is read at every READ.
 */
function startMockPanel({ data = {}, failReads = [], onMessage } = {}) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const panel = {
        server,
        sockets: [],
        received: [],
        logins: 0,
        data: { ...DEFAULT_DATA, ...data },
        failReads: new Set(failReads),
    };
    server.on('connection', (socket) => {
        panel.sockets.push(socket);
        socket.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            panel.received.push(message);
            if (onMessage && onMessage(message, socket, panel) === true) return;
            const d = panel.data;
            const ok = (extra) => ({ RESULT: 'OK', RESULT_DETAIL: 'READ_OK', ...extra });
            if (message.CMD === 'LOGIN') {
                panel.logins += 1;
                socket.send(frame('LOGIN_RES', message.ID, 'USER', { RESULT: 'OK', RESULT_DETAIL: 'LOGIN_OK', ID_LOGIN: String(panel.logins) }));
                return;
            }
            if (message.CMD === 'READ') {
                const type = message.PAYLOAD_TYPE;
                const answers = {
                    ZONES: () => ok({ ZONES: d.ZONES }),
                    MULTI_TYPES: () => ok({ OUTPUTS: d.OUTPUTS, SCENARIOS: d.SCENARIOS, BUS_HAS: d.BUS_HAS }),
                    STATUS_OUTPUTS: () => ok({ STATUS_OUTPUTS: d.STATUS_OUTPUTS }),
                    STATUS_BUS_HA_SENSORS: () => ok({ STATUS_BUS_HA_SENSORS: d.STATUS_BUS_HA_SENSORS }),
                    STATUS_SYSTEM: () => ok({ STATUS_SYSTEM: d.STATUS_SYSTEM }),
                };
                const answer = !panel.failReads.has(type) && answers[type];
                socket.send(frame('READ_RES', message.ID, type, answer
                    ? answer()
                    : { RESULT: 'FAIL', RESULT_DETAIL: 'CMD_NOT_AVAILABLE' }));
                return;
            }
            if (message.CMD === 'REALTIME') {
                socket.send(frame('REALTIME_RES', message.ID, 'REGISTER_ACK', {
                    RESULT: 'OK', RESULT_DETAIL: 'REALTIME_START_OK',
                    STATUS_OUTPUTS: d.STATUS_OUTPUTS, STATUS_BUS_HA_SENSORS: d.STATUS_BUS_HA_SENSORS,
                    STATUS_ZONES: d.STATUS_ZONES, STATUS_SYSTEM: d.STATUS_SYSTEM,
                }));
                return;
            }
            if (message.CMD === 'CMD_USR') {
                socket.send(frame('CMD_USR_RES', message.ID, 'REPLY', { RESULT: 'OK', RESULT_DETAIL: 'CMD_PROCESSED' }));
            }
        });
    });
    /** Pushes a realtime CHANGES frame on the latest connection. */
    panel.realtime = (statusData) => panel.sockets[panel.sockets.length - 1]
        .send(frame('REALTIME', '0', 'CHANGES', { '00:00:00:00:00:00': statusData }));
    panel.sendRaw = (text) => panel.sockets[panel.sockets.length - 1].send(text);
    /** Drops every open connection: the client sees the socket close and reconnects. */
    panel.dropConnections = () => {
        for (const socket of panel.sockets) socket.terminate();
    };
    panel.close = async () => {
        panel.dropConnections();
        await new Promise((resolve) => server.close(resolve));
    };
    return new Promise((resolve) => server.on('listening', () => {
        panel.port = server.address().port;
        resolve(panel);
    }));
}

/** Logger that records `[level] message` lines (stack traces included). */
function recordingLog() {
    const lines = [];
    const at = (level) => (...args) => lines.push(`[${level}] ${args.map(String).join(' ')}`);
    return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug'), success: at('info') };
}

module.exports = { frame, startMockPanel, recordingLog, DEFAULT_DATA };
