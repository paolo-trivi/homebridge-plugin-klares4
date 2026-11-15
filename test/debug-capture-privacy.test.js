'use strict';

// The debug file is confidential and says so (SP-01, SP-18, SP-23). Frames are
// redacted by key at any depth, in both directions, in the device snapshots
// and in the sections derived from them; frames that are not JSON are masked as
// text; the file is written 0600 and capped in messages and bytes. Field names
// come from real captures (names only were read); every value here is synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { captureRawMessage } = require('../dist/debug-capture/raw-message-capture.js');
const { DebugCaptureManager } = require('../dist/debug-capture/index.js');
const { DebugFileGenerator } = require('../dist/debug-capture/file-generator.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');
const { waitFor } = require('./fixtures/wait-for.js');

const PIN = '482913';
const SECRETS = {
    pin: PIN,
    pinNumber: '715204',
    password: 'Sup3rS3gret0',
    lat: '45.1234567',
    long: '9.7654321',
    description: 'Mario Rossi',
    account: '7391',
    serial: '906142',
    panelId: 'A1B2C3D4E5F6',
    dawn: '06:41',
    dusk: '17:23',
};
const secretValues = Object.values(SECRETS);
const leaks = (text) => secretValues.filter((value) => text.includes(value));
const serialized = (captured) => `${captured.rawData}\n${JSON.stringify(captured.parsed)}`;
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const recording = () => {
    const lines = [];
    const at = (level) => (...args) => lines.push(`[${level}] ${args.join(' ')}`);
    return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
};

// ---------------------------------------------------------------------------
// Redaction by key, at any depth.
// ---------------------------------------------------------------------------

const KEY_CASES = {
    'out LOGIN, string PIN': ['out', { SENDER: 'hb', CMD: 'LOGIN', PAYLOAD: { PIN } }],
    'out LOGIN, numeric PIN': ['out', { CMD: 'LOGIN', PAYLOAD: { PIN: Number(SECRETS.pinNumber) } }],
    'out CMD_USR with PIN and OUTPUT': ['out', { CMD: 'CMD_USR', PAYLOAD: { ID_LOGIN: '1', PIN, OUTPUT: { ID: '3', STA: 'ON' } } }],
    'PIN one level deeper': ['out', { CMD: 'X', PAYLOAD: { USER: { PIN } } }],
    'PIN in an array element': ['out', { CMD: 'X', PAYLOAD: { USERS: [{ ID: '1', PIN }] } }],
    'PIN at the root': ['out', { CMD: 'X', PIN }],
    'lower-case pin': ['out', { CMD: 'X', PAYLOAD: { pin: PIN } }],
    'PIN_CODE, USER_PIN, PASSWORD, CODE': ['out', { CMD: 'X', PAYLOAD: { PIN_CODE: PIN, USER_PIN: PIN, PASSWORD: SECRETS.password, CODE: PIN } }],
    'PIN as an array': ['out', { CMD: 'X', PAYLOAD: { PIN: [PIN] } }],
    'PIN as an object': ['out', { CMD: 'X', PAYLOAD: { PIN: { value: PIN } } }],
    'PAYLOAD as a JSON string': ['out', { CMD: 'LOGIN', PAYLOAD: JSON.stringify({ PIN }) }],
    'PAYLOAD as a JSON string, nested twice': ['out', { CMD: 'LOGIN', PAYLOAD: JSON.stringify({ INNER: JSON.stringify({ PIN }) }) }],
    'in LOGIN_RES': ['in', {
        CMD: 'LOGIN_RES',
        PAYLOAD: {
            RESULT: 'OK', ID_LOGIN: '1', ID_ACCOUNT: SECRETS.account, DESCRIPTION: SECRETS.description, '4DIGIT_PIN': 'F',
            POSITION: { LAT: SECRETS.lat, LONG: SECRETS.long },
        },
    }],
    'LAT and LONG outside POSITION': ['in', { CMD: 'X', PAYLOAD: { SITE: { LAT: SECRETS.lat, LONG: SECRETS.long } } }],
    'position under another key': ['in', { CMD: 'X', PAYLOAD: { POSITION: SECRETS.lat } }],
    'sensor serial numbers': ['in', { CMD: 'REALTIME', PAYLOAD: { STATUS_BUS_HA_SENSORS: [{ ID: '1', SN: SECRETS.serial, LINK: { SN: SECRETS.serial, BUS: '1' } }] } }],
    'dawn and dusk (they give the position away)': ['in', { CMD: 'X', PAYLOAD: { STATUS_SYSTEM: [{ ID: '1', TIME: { DAWN: SECRETS.dawn, DUSK: SECRETS.dusk, GMT: '1700000000' } }] } }],
    'the panel identifier in SENDER': ['in', { SENDER: SECRETS.panelId, RECEIVER: 'hb', CMD: 'X' }],
};

for (const [label, [direction, frame]] of Object.entries(KEY_CASES)) {
    test(`redaction by key: ${label}`, () => {
        const captured = captureRawMessage(direction, JSON.stringify(frame));
        assert.deepEqual(leaks(serialized(captured)), []);
        assert.ok(serialized(captured).includes('***MASKED***'));
    });
}

test('what the diagnosis needs survives: names, states, categories, flags, ids, the plugin sender', () => {
    const frame = {
        SENDER: 'hb', RECEIVER: '', CMD: 'READ_RES', ID: '4821', PAYLOAD_TYPE: 'MULTI_TYPES', CRC_16: '0x1a2b', TIMESTAMP: '1700000000',
        PAYLOAD: {
            RESULT: 'OK', ID_LOGIN: '1',
            ZONES: [{ ID: '1', DES: 'Kitchen window', CAT: 'WINDOW', BYP_EN: 'T' }],
            OUTPUTS: [{ ID: '5', DES: 'Hall light', CAT: 'LIGHT', MOD: 'B' }],
            SCENARIOS: [{ ID: '1', DES: 'Evening', CAT: 'GEN', PIN: 'N' }, { ID: '2', DES: 'Arm all', CAT: 'ARM', PIN: 'PR' }],
            STATUS_SYSTEM: [{ ID: '1', ARM: { D: 'T', S: 'F' }, TIME: { GMT: '1700000000', TZ: '1' } }],
            VER_LITE: { FW: '1.2.3' },
        },
    };
    const captured = captureRawMessage('out', JSON.stringify(frame));
    assert.deepEqual(captured.parsed, frame, 'nothing to redact: the frame is kept as it is');
    assert.equal(captured.rawData, JSON.stringify(frame), 'and so is the text');
});

test('the scenario PIN flag is kept but a PIN-like value in the same place is not', () => {
    const flag = captureRawMessage('in', JSON.stringify({ PAYLOAD: { SCENARIOS: [{ ID: '1', PIN: 'N' }] } }));
    assert.equal(flag.parsed.PAYLOAD.SCENARIOS[0].PIN, 'N');
    const digits = captureRawMessage('in', JSON.stringify({ PAYLOAD: { SCENARIOS: [{ ID: '1', PIN: PIN }] } }));
    assert.deepEqual(leaks(serialized(digits)), []);
    const elsewhere = captureRawMessage('in', JSON.stringify({ PAYLOAD: { OUTPUTS: [{ ID: '1', PIN: 'N' }] } }));
    assert.equal(elsewhere.parsed.PAYLOAD.OUTPUTS[0].PIN, '***MASKED***', 'only scenarios carry the flag');
});

test('an outgoing SENDER (the plugin label) is kept, an incoming one (the panel) is not', () => {
    assert.equal(captureRawMessage('out', JSON.stringify({ SENDER: 'homebridge', CMD: 'X' })).parsed.SENDER, 'homebridge');
    assert.equal(captureRawMessage('in', JSON.stringify({ SENDER: SECRETS.panelId, CMD: 'X' })).parsed.SENDER, '***MASKED***');
});

test('rawData and parsed carry the same redacted content', () => {
    const captured = captureRawMessage('in', JSON.stringify(KEY_CASES['in LOGIN_RES'][1]));
    assert.deepEqual(JSON.parse(captured.rawData), captured.parsed);
});

test('a key called __proto__ or constructor does not pollute and does not throw', () => {
    const hostile = '{"CMD":"X","PAYLOAD":{"__proto__":{"PIN":"482913","polluted":true},"constructor":{"PIN":"482913"}}}';
    const captured = captureRawMessage('in', hostile);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(leaks(serialized(captured)), []);
});

test('the real field names of a LOGIN_RES and of the status frames: only the sensitive ones change', () => {
    // Paths observed in real captures (names only), with synthetic values.
    const frame = {
        SENDER: SECRETS.panelId, RECEIVER: 'hb', CMD: 'LOGIN_RES', ID: '1', PAYLOAD_TYPE: 'USER', TIMESTAMP: '1700000000', CRC_16: '0x0000',
        PAYLOAD: {
            RESULT: 'OK', RESULT_DETAIL: 'LOGIN_OK', ID_LOGIN: '1', ID_ACCOUNT: SECRETS.account, DESCRIPTION: SECRETS.description,
            LEV: '1', '4DIGIT_PIN': 'F', MAINTENANCE: 'F', CONNECTION: 'LOCAL', SYSTEM_LANG: 'ITA',
            POSITION: { LAT: SECRETS.lat, LONG: SECRETS.long },
            VER_LITE: { FW: '1.0.0', VM: '1.0', VM_REQ: '1.0', WS: '1.0.0', WS_REQ: '1.0.0' },
            MAX_BUS_DCS: '8', MAX_IP_CAMERAS: '4', MAX_TIMED_ACCESS: '10', WARN_COUNT: '0', FREEZE_STATE: 'F', SESSION_STATE: 'ON',
            PRG_CHECK: { CFG: 'AB', PRG: 'CD' },
            STATUS_ZONES: [{ ID: '1', STA: 'R', BYP: 'NO', T: 'N', A: 'N', FM: 'F', OHM: '4000', VAS: 'F', LBL: '' }],
            STATUS_OUTPUTS: [{ ID: '5', STA: 'OFF', POS: '0', TPOS: '0', ISBLK: 'F', ISCAL: 'T' }],
            STATUS_SYSTEM: [{ ID: '1', ARM: { D: 'T', S: 'F' }, FAULT_MEM: [], TEMP: { IN: '21.0', OUT: '9.0' }, TIME: { DAWN: SECRETS.dawn, DUSK: SECRETS.dusk, GMT: '1700000000', TZ: '1', TZM: '060' } }],
            STATUS_TEMPERATURES: [{ ID: '1', TEMP: '21.0', THERM: { ACT_MODEL: 'MAN', ACT_SEA: 'WIN', ACT_TOF: 'OFF', OUT_STATUS: 'OFF', TEMP_THR: { T: 'M', VAL: '20.0' } } }],
            STATUS_BUS_HA_SENSORS: [{
                ID: '1', BUS: '1', TYP: 'DOMUS', FW: '1.0.0', HW: '1.0', STA: 'OK', UA: 'F', SN: SECRETS.serial,
                LINK: { BUS: '1', SN: SECRETS.serial, TYPE: 'T' }, DOMUS: { TEM: '21.0', HUM: '45', LHT: '100', PIR: 'N', TL: '1', TH: '2' },
            }],
            BUS_HAS: [{ ID: '1', DES: 'Domus One', TYP: 'DOMUS' }],
            CFG_THERMOSTATS: [{ ID: '1', ACT_MODE: 'MAN', ACT_SEA: 'WIN', MAN_HRS: '1', TOF: { E: 'F', T: '0' }, WIN: { TM: '20.0', T1: '18', MON: [{ S: '0600', T: '20' }] } }],
        },
    };
    const captured = captureRawMessage('in', JSON.stringify(frame));
    const changed = [];
    const compare = (before, after, trail) => {
        if (after === '***MASKED***' && before !== '***MASKED***') { changed.push(trail); return; }
        if (Array.isArray(before)) { before.forEach((item, i) => compare(item, after[i], `${trail}[]`)); return; }
        if (before && typeof before === 'object') { for (const k of Object.keys(before)) compare(before[k], after[k], trail ? `${trail}.${k}` : k); return; }
        assert.equal(after, before, `${trail} must be kept`);
    };
    compare(frame, captured.parsed, '');
    assert.deepEqual([...new Set(changed)].sort(), [
        'PAYLOAD.4DIGIT_PIN', 'PAYLOAD.DESCRIPTION', 'PAYLOAD.ID_ACCOUNT', 'PAYLOAD.POSITION',
        'PAYLOAD.STATUS_BUS_HA_SENSORS[].LINK.SN', 'PAYLOAD.STATUS_BUS_HA_SENSORS[].SN',
        'PAYLOAD.STATUS_SYSTEM[].TIME.DAWN', 'PAYLOAD.STATUS_SYSTEM[].TIME.DUSK', 'SENDER',
    ]);
    assert.deepEqual(leaks(serialized(captured)), []);
});

// ---------------------------------------------------------------------------
// Families of keys (defence in depth), and the position of a cover is not a place.
// ---------------------------------------------------------------------------

const SENSITIVE_VARIANTS = [
    'userPin', 'USERPIN', 'PINCODE', 'PIN1', 'PIN-CODE', 'pin_code', 'newPin', 'pinNumber', 'MASTER_PIN',
    'passcode', 'passCode', 'passwd', 'USER_PASSWORD', 'userPassword', 'passwordHash', 'pass',
    'secret', 'clientSecret', 'authToken', 'ACCESS_TOKEN', 'token2',
    'accessCode', 'securityCode', 'unlockCode', 'CODE', 'code1',
    'SERIAL_NUMBER', 'serialNo', 'serialNumber', 'SERIAL', 'SN', 'sn2',
    'MAC', 'mac', 'MAC_ADDRESS', 'macAddress', 'deviceMac', 'IMEI', 'imei', 'ICCID', 'EMAIL', 'userEmail',
];
const HARMLESS_KEYS = [
    'PING', 'PINNED', 'PINK', 'PIR', 'MACHINE', 'MACRO', 'MAINTENANCE', 'PASSIVE', 'COMPASS', 'PASSED',
    'ERROR_CODE', 'RESULT_CODE', 'STATUS_CODE', 'errorCode', 'CODEC', 'TOKENS_LEFT_IS_NOT_A_THING_X',
    'SENSOR', 'SERIALIZER', 'IMEIS_NOT', 'POS', 'TPOS', 'targetPosition', 'positionX', 'DES', 'ID_LOGIN',
    'STA', 'ACT_MODEL', 'TEMP_THR', 'PRG_CHECK', 'description', 'name',
];

for (const key of SENSITIVE_VARIANTS) {
    test(`redaction by key family: ${key} is masked`, () => {
        const frame = { CMD: 'X', PAYLOAD: { [key]: '482913', NESTED: [{ [key]: 482913 }] } };
        const captured = captureRawMessage('out', JSON.stringify(frame));
        assert.equal(captured.parsed.PAYLOAD[key], '***MASKED***');
        assert.equal(captured.parsed.PAYLOAD.NESTED[0][key], '***MASKED***');
        assert.deepEqual(leaks(serialized(captured)), []);
    });
}

test('keys that only look like a credential are kept', () => {
    const payload = Object.fromEntries(HARMLESS_KEYS.map((key) => [key, 'visible']));
    const captured = captureRawMessage('in', JSON.stringify({ CMD: 'X', PAYLOAD: payload }));
    assert.deepEqual(captured.parsed.PAYLOAD, payload);
});

test('the position of a cover or a shutter is state, not a place: it stays in the snapshots', async (t) => {
    const devices = [{
        id: 'cover_1', type: 'cover', name: 'Shutter', description: 'Shutter',
        status: { position: 40, targetPosition: 60, state: 'opening' },
    }];
    const { data } = await captureToFile(t, { devices });
    assert.deepEqual(data.deviceSnapshots[0].devices[0].status, { position: 40, targetPosition: 60, state: 'opening' });
});

test('a geographic position is masked wherever it comes from, a numeric `position` only in frames', () => {
    for (const direction of ['in', 'out']) {
        for (const POSITION of [{ LAT: SECRETS.lat, LONG: SECRETS.long }, SECRETS.lat, Number(SECRETS.lat), [Number(SECRETS.lat), Number(SECRETS.long)]]) {
            const captured = captureRawMessage(direction, JSON.stringify({ CMD: 'X', PAYLOAD: { POSITION } }));
            assert.equal(captured.parsed.PAYLOAD.POSITION, '***MASKED***');
        }
    }
    const { redactSnapshot } = require('../dist/debug-capture/redaction.js');
    assert.equal(redactSnapshot([{ status: { position: 40 } }])[0].status.position, 40);
    assert.equal(redactSnapshot([{ status: { position: { lat: 45.1, long: 9.7 } } }])[0].status.position, '***MASKED***');
    assert.equal(redactSnapshot([{ position: SECRETS.lat }])[0].position, '***MASKED***');
    assert.equal(redactSnapshot([{ status: { position: 40 }, lat: 45.1 }])[0].lat, '***MASKED***');
});

test('a JSON string payload larger than the nested-JSON limit is masked as text, not passed through', () => {
    const padding = 'x'.repeat(1_100_000);
    const nested = `{"PIN":"${PIN}","PAD":"${padding}"}`;
    const captured = captureRawMessage('out', JSON.stringify({ CMD: 'LOGIN', PAYLOAD: nested }));
    assert.deepEqual(leaks(serialized(captured)), []);
});

test('a JSON string payload that does not parse (cut short) is masked as text', () => {
    const cut = `{"PIN":"${PIN}","PAD":`;
    const captured = captureRawMessage('out', JSON.stringify({ CMD: 'LOGIN', PAYLOAD: cut }));
    assert.deepEqual(leaks(serialized(captured)), []);
});

// ---------------------------------------------------------------------------
// Frames that are not JSON objects: masked as text.
// ---------------------------------------------------------------------------

const TEXT_CASES = {
    'truncated JSON': JSON.stringify({ CMD: 'LOGIN', PAYLOAD: { PIN } }).slice(0, -3),
    'cut right after the value, quote still open': `{"CMD":"LOGIN","PAYLOAD":{"PIN":"${PIN}`,
    'two frames glued together': JSON.stringify({ CMD: 'LOGIN', PAYLOAD: { PIN } }) + JSON.stringify({ CMD: 'PING' }),
    'a prefix before the frame': `\u0000${JSON.stringify({ CMD: 'LOGIN', PAYLOAD: { PIN } })}`,
    'a numeric PIN in broken JSON': `{"CMD":"LOGIN","PAYLOAD":{"PIN":${SECRETS.pinNumber},`,
    'a lower-case password in broken JSON': `{"password": "${SECRETS.password}", "x":`,
    'position in broken JSON': `{"POSITION":{"LAT":"${SECRETS.lat}","LONG":"${SECRETS.long}"},"x":`,
    'escaped quotes around the value': `{"PIN":"${PIN}\\"x`,
    'a JSON string holding a frame': JSON.stringify(`{"PIN":"${PIN}"}`),
    'unquoted key and value': `login PIN=${PIN} ok`,
    'a space between word and value': `login PIN ${PIN} ok`,
    'a lower-case word and a space': `set pin ${SECRETS.pinNumber}`,
    'a camelCase key in broken JSON': `{"userPin":"${PIN}","x":`,
    'a PINCODE key in broken JSON': `{"PINCODE":${SECRETS.pinNumber},"x":`,
    'single-quoted pairs': `{'PIN': '${PIN}', 'x':`,
    'a serial number in text': `{"SERIAL_NUMBER":"${SECRETS.serial}","x":`,
    'a password after a space': `password ${SECRETS.password}`,
};

for (const [label, text] of Object.entries(TEXT_CASES)) {
    test(`non-JSON frame is masked as text: ${label}`, () => {
        const captured = captureRawMessage('out', text);
        assert.equal(captured.parsed, null);
        assert.deepEqual(leaks(serialized(captured)), []);
    });
}

test('a frame nested far deeper than any real one is cut, not recursed into, and leaks nothing', () => {
    const depth = 20000;
    const text = `${'{"A":'.repeat(depth)}{"PIN":"${PIN}"}${'}'.repeat(depth)}`;
    const captured = captureRawMessage('in', text);
    assert.deepEqual(leaks(serialized(captured)), []);
});

// ---------------------------------------------------------------------------
// The file: snapshots, analysis, mode, texts.
// ---------------------------------------------------------------------------

function wsClient(devices) {
    let listener;
    return {
        emit: (direction, text) => listener?.(direction, text),
        getAllDevices: () => devices,
        addRawMessageListener: (fn) => { listener = fn; return () => { listener = undefined; }; },
    };
}

const generatedFiles = (dir) => fs.readdirSync(dir).filter((name) => /^klares4-debug-.*\.json$/.test(name));
const fileMode = (file) => fs.statSync(file).mode & 0o777;

async function captureToFile(t, { devices = [], frames = [], sync = false, manager: options } = {}) {
    const dir = tmpStorage(t, 'klares4-privacy-');
    const log = recording();
    const client = wsClient(devices);
    const manager = new DebugCaptureManager(log, dir, options);
    manager.startCapture(client, 600_000);
    for (const [direction, text] of frames) client.emit(direction, text);
    if (sync) manager.shutdown(); else manager.stopCapture(client);
    // The file is renamed into place first and the report is logged once it is on disk:
    // wait for that report, the condition the callers check, not for an earlier effect.
    await waitFor(() => log.lines.some((line) => /^\[warn\] \[PRIVACY\][^\n]*0600/.test(line)));
    assert.equal(generatedFiles(dir).length, 1);
    const file = path.join(dir, generatedFiles(dir)[0]);
    return { dir, file, log, text: fs.readFileSync(file, 'utf8'), data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const ALL_SECRET_FRAMES = () => [
    ['out', JSON.stringify({ SENDER: 'hb', CMD: 'LOGIN', PAYLOAD: { PIN } })],
    ['in', JSON.stringify(KEY_CASES['in LOGIN_RES'][1])],
    ['in', JSON.stringify(KEY_CASES['sensor serial numbers'][1])],
    ['in', JSON.stringify(KEY_CASES['dawn and dusk (they give the position away)'][1])],
    ['in', JSON.stringify(KEY_CASES['the panel identifier in SENDER'][1])],
    ['out', TEXT_CASES['cut right after the value, quote still open']],
];

test('the written file holds none of the secrets, anywhere, and keeps the device names', async (t) => {
    const devices = [{ id: 'zone_1', type: 'zone', name: 'Kitchen window', description: 'Kitchen window', status: { open: true, armed: false } }];
    const { text, data } = await captureToFile(t, { devices, frames: ALL_SECRET_FRAMES() });
    assert.deepEqual(leaks(text), []);
    assert.ok(text.includes('Kitchen window'), 'names are needed for the diagnosis');
    assert.equal(data.deviceSnapshots[0].devices[0].name, 'Kitchen window');
    assert.ok(data.rawMessages.length === ALL_SECRET_FRAMES().length);
    assert.ok(data.analysis.commandsSeen.includes('LOGIN_RES'));
});

test('secrets that reach the device snapshots are redacted by key too, the device description stays', async (t) => {
    const devices = [{
        id: 'thermostat_1', type: 'thermostat', name: 'Study', description: 'Study thermostat',
        status: { mode: 'heat' }, pin: PIN, extra: { serial: SECRETS.serial, PASSWORD: SECRETS.password, position: { lat: SECRETS.lat } },
    }];
    const { text, data } = await captureToFile(t, { devices });
    assert.deepEqual(leaks(text), []);
    assert.equal(data.deviceSnapshots[0].devices[0].description, 'Study thermostat');
    assert.equal(data.deviceSnapshots[0].devices[0].name, 'Study');
});

test('the file is written 0600, by the asynchronous and by the shutdown path', { skip: process.platform === 'win32' }, async (t) => {
    const previous = process.umask(0o000);
    t.after(() => process.umask(previous));
    for (const sync of [false, true]) {
        const { file } = await captureToFile(t, { sync, frames: ALL_SECRET_FRAMES() });
        assert.equal(fileMode(file).toString(8), '600', sync ? 'shutdown path' : 'asynchronous path');
    }
});

test('the texts say the file is confidential and no longer promise it can be shared', async (t) => {
    const { data, log } = await captureToFile(t, { frames: ALL_SECRET_FRAMES() });
    const instructions = JSON.stringify(data.instructions);
    assert.match(instructions, /confidential/i);
    assert.match(instructions, /names of your devices/i);
    assert.match(instructions, /alarm system/i);
    assert.match(instructions, /public issue/i);
    assert.doesNotMatch(instructions, /already masked for security/i);
    const lines = log.lines.join('\n');
    assert.doesNotMatch(lines, /Share this file for support/i);
    assert.doesNotMatch(lines, /PINs are already masked/i);
    assert.match(lines, /\[PRIVACY\][^\n]*confidential/i);
    assert.match(lines, /\[PRIVACY\][^\n]*public issue/i);
    assert.match(lines, /\[PRIVACY\][^\n]*0600/);
});

test('starting a capture warns up front that the file will be confidential', (t) => {
    const log = recording();
    const manager = new DebugCaptureManager(log, tmpStorage(t, 'klares4-privacy-'));
    manager.startCapture(wsClient([]), 10_000);
    manager.shutdown();
    assert.match(log.lines.join('\n'), /\[PRIVACY\][^\n]*confidential/i);
});

// ---------------------------------------------------------------------------
// The buffer is capped in messages and in bytes.
// ---------------------------------------------------------------------------

test('the message cap keeps the first messages, counts the rest and warns once', async (t) => {
    const frames = Array.from({ length: 12 }, (_, i) => ['in', JSON.stringify({ CMD: 'REALTIME', ID: String(i) })]);
    const { data, log } = await captureToFile(t, { frames, manager: { limits: { maxMessages: 5, maxBytes: 1_000_000 } } });
    assert.equal(data.rawMessages.length, 5);
    assert.equal(JSON.parse(data.rawMessages[0].rawData).ID, '0');
    assert.equal(data.captureInfo.totalRawMessages, 5);
    assert.equal(data.captureInfo.droppedMessages, 7);
    assert.equal(log.lines.filter((line) => /Capture buffer full/.test(line)).length, 1, 'one warning, not one per message');
});

test('the byte cap stops recording before the buffer outgrows it', async (t) => {
    const frame = JSON.stringify({ CMD: 'REALTIME', PAYLOAD: { PAD: 'x'.repeat(1000) } });
    const frames = Array.from({ length: 50 }, () => ['in', frame]);
    const { data } = await captureToFile(t, { frames, manager: { limits: { maxMessages: 1000, maxBytes: 10_000 } } });
    const stored = data.rawMessages.reduce((sum, m) => sum + Buffer.byteLength(m.rawData), 0);
    assert.ok(stored <= 10_000, `stored ${stored} bytes`);
    assert.ok(data.rawMessages.length >= 5 && data.rawMessages.length < 50);
    assert.equal(data.captureInfo.droppedMessages, 50 - data.rawMessages.length);
});

test('without reaching a cap nothing is dropped', async (t) => {
    const { data, log } = await captureToFile(t, { frames: ALL_SECRET_FRAMES() });
    assert.equal(data.captureInfo.droppedMessages, 0);
    assert.equal(log.lines.some((line) => /Capture buffer full/.test(line)), false);
});

// ---------------------------------------------------------------------------
// The start helper follows the runtime config.
// ---------------------------------------------------------------------------

test('the requested capture runs for the duration the runtime config validated', (t) => {
    const { startRequestedDebugCapture } = require('../dist/platform/debug-capture-start.js');
    const log = recording();
    const capture = startRequestedDebugCapture(600_000, log, tmpStorage(t, 'klares4-privacy-'), wsClient([]));
    t.after(() => capture.shutdown());
    assert.match(log.lines.join('\n'), /starting 600-second capture/);
    assert.equal(capture.captureDurationMs, 600_000);
});

// ---------------------------------------------------------------------------
// The file stays small enough to send privately.
// ---------------------------------------------------------------------------

test('a frame is written once: the text, not a second parsed copy', async (t) => {
    const { data } = await captureToFile(t, { frames: ALL_SECRET_FRAMES() });
    for (const message of data.rawMessages) {
        assert.deepEqual(Object.keys(message).sort(), ['direction', 'rawData', 'timestamp']);
    }
    assert.ok(data.rawMessages.some((message) => JSON.parse(message.rawData).CMD === 'LOGIN'));
    assert.ok(data.analysis.commandsSeen.includes('LOGIN'), 'the analysis still reads the frames');
});

test('with the default limits a flood of large frames gives a file of a few MiB, written 0600', { skip: process.platform === 'win32' }, async (t) => {
    const frame = JSON.stringify({ CMD: 'REALTIME', PAYLOAD_TYPE: 'CHANGES', PAYLOAD: { homebridge: { STATUS_ZONES: Array.from({ length: 40 }, (_, i) => ({ ID: String(i), STA: 'R', BYP: 'NO', T: 'N', A: 'N', FM: 'F', OHM: '4000' })) } } });
    const frames = Array.from({ length: 1500 }, () => ['in', frame]);
    const { file, data } = await captureToFile(t, { frames, sync: true });
    const size = fs.statSync(file).size;
    assert.ok(size < 6 * 1024 * 1024, `file of ${size} bytes`);
    assert.ok(data.captureInfo.droppedMessages > 0);
    assert.equal(data.rawMessages.length + data.captureInfo.droppedMessages, 1500);
    assert.equal(fileMode(file).toString(8), '600');
});

test('an interval snapshot identical to the last one is not stored again; start and end always are', async (t) => {
    const dir = tmpStorage(t, 'klares4-privacy-');
    const devices = [{ id: 'light_1', type: 'light', name: 'Lamp', status: { on: false } }];
    const client = wsClient(devices);
    const log = recording();
    const manager = new DebugCaptureManager(log, dir);
    const timers = [];
    const realSetInterval = global.setInterval;
    global.setInterval = (fn, ms) => { timers.push(fn); return realSetInterval(() => undefined, 1 << 30); };
    try {
        manager.startCapture(client, 600_000);
    } finally {
        global.setInterval = realSetInterval;
    }
    assert.equal(timers.length, 1);
    timers[0](); timers[0]();                       // unchanged
    devices[0].status.on = true; timers[0]();       // changed
    timers[0]();                                    // unchanged again
    manager.shutdown();
    const file = path.join(dir, generatedFiles(dir)[0]);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(data.deviceSnapshots.map((s) => s.label), ['START', 'INTERVAL', 'END']);
    assert.equal(data.deviceSnapshots[1].devices[0].status.on, true);
    assert.equal(data.captureInfo.deviceSnapshotsTaken, 3);
});
