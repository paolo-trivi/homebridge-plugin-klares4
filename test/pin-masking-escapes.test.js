'use strict';

// WS-11: the PIN mask survives JSON escapes and non-string values, and the
// LOGIN frame is not written in full to the INFO log at every login.

const test = require('node:test');
const assert = require('node:assert/strict');

const { maskSensitiveData } = require('../dist/log-levels.js');
const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
const { recordingLog } = require('./fixtures/command-client.js');

test('PIN values with quotes, backslashes and non-string types are masked whole', () => {
    const pins = ['ab"cd', '13"5790', '12\\"34', '\\', 'x\\\\"y', 'a,b}c', true, false, null, [1, 2], { v: '9876' }, -12.5e3];
    for (const pin of pins) {
        const json = JSON.stringify({ CMD: 'LOGIN', PAYLOAD: { PIN: pin }, CRC_16: '0x0000' });
        const masked = maskSensitiveData(`Sending: ${json}`);
        assert.equal(masked, `Sending: ${JSON.stringify({ CMD: 'LOGIN', PAYLOAD: { PIN: '***' }, CRC_16: '0x0000' })}`, `PIN ${JSON.stringify(pin)}`);
    }
});

test('every PIN key is masked, whatever its case and spacing, and the rest is kept', () => {
    const text = '{"pin" : "1234","OUTPUT":{"ID":"5"},"Pin":5678,"PINNED":"keep"}';
    assert.equal(maskSensitiveData(text), '{"pin":"***","OUTPUT":{"ID":"5"},"Pin":"***","PINNED":"keep"}');
});

const SECRET = '482913';
const PASSWORD = 'Synth3ticPass';

test('repro secpriv d3: every credential key, array and object values, truncated frames and string payloads', () => {
    const frames = {
        'PIN_CODE / USER_PIN / PASSWORD / CODE / 4DIGIT_PIN': JSON.stringify({ CMD: 'X', PAYLOAD: { PIN_CODE: SECRET, USER_PIN: SECRET, PASSWORD, CODE: SECRET, '4DIGIT_PIN': SECRET, pwd: SECRET, Token: SECRET } }),
        'PIN as array': JSON.stringify({ CMD: 'X', PAYLOAD: { PIN: [SECRET, { v: SECRET }] } }),
        'PIN as object': JSON.stringify({ CMD: 'X', PAYLOAD: { PIN: { value: SECRET, list: [SECRET] } } }),
        'PIN nested and in arrays': JSON.stringify({ CMD: 'X', PAYLOAD: { USERS: [{ ID: '1', PIN: SECRET }], USER: { PIN: Number(SECRET) } } }),
        'truncated JSON': JSON.stringify({ CMD: 'LOGIN', PAYLOAD: { PIN: SECRET } }).slice(0, -3),
        'truncated inside the value': '{"CMD":"LOGIN","PAYLOAD":{"PIN":"4829',
        'two concatenated frames': JSON.stringify({ CMD: 'LOGIN', PAYLOAD: { PIN: SECRET } }) + JSON.stringify({ CMD: 'PING' }),
        'prefixed frame': '\u0000' + JSON.stringify({ CMD: 'LOGIN', PAYLOAD: { PIN: SECRET } }),
        'PAYLOAD as JSON string': JSON.stringify({ CMD: 'LOGIN', PAYLOAD: JSON.stringify({ PIN: SECRET, PASSWORD }) }),
        'string PAYLOAD with array PIN and escapes': JSON.stringify({ CMD: 'X', PAYLOAD: JSON.stringify({ PIN: [`a"${SECRET}`], OTHER: 'k\\' }) }),
        'string PAYLOAD with a quoted PIN': JSON.stringify({ CMD: 'X', PAYLOAD: JSON.stringify({ PIN: `x"\\${SECRET}` }) }),
    };
    for (const [label, raw] of Object.entries(frames)) {
        const line = maskSensitiveData(`Sending: ${raw}`);
        for (const fragment of [SECRET, '4829', '2913', PASSWORD]) {
            assert.ok(!line.includes(fragment), `${label}: ${line.split(fragment).join('<LEAK>')}`);
        }
    }
});

test('masking keeps the rest of the frame readable and leaves other keys alone', () => {
    const raw = JSON.stringify({ CMD: 'CMD_USR', PAYLOAD: JSON.stringify({ ID_LOGIN: '1', PIN: SECRET, OUTPUT: { ID: '5', STA: 'ON' } }) });
    const masked = JSON.parse(maskSensitiveData(raw));
    assert.deepEqual(JSON.parse(masked.PAYLOAD), { ID_LOGIN: '1', PIN: '***', OUTPUT: { ID: '5', STA: 'ON' } });
    const plain = '{"ID_LOGIN":"1","OUTPUT":{"ID":"5","STA":"ON"},"DES":"pin code: none","PINNED":"keep"}';
    assert.equal(maskSensitiveData(plain), plain);
});

test('a truncated frame is masked up to its end', () => {
    assert.equal(maskSensitiveData('{"PIN":"12\\"34'), '{"PIN":"***"');
    assert.equal(maskSensitiveData('no pin here'), 'no pin here');
});

test('repro 01: a PIN containing a quote leaves no fragment in any log line; LOGIN is not logged in full at INFO', async () => {
    for (const logLevel of [1, 2]) {
        const { log, lines } = recordingLog();
        const client = new KseniaWebSocketClient('127.0.0.1', 1, false, 'hb', '13"5790', log, { logLevel });
        client['state'].ws = { readyState: 1 };
        client['wsTransport'].send = async () => undefined;
        await client['commandService'].sendLoginCommand();
        for (const [level, line] of lines) {
            assert.ok(!line.includes('5790'), `PIN fragment in ${level} line`);
            if (level === 'info') assert.ok(!line.includes('"CMD":"LOGIN"'), 'LOGIN frame logged at INFO');
        }
        if (logLevel === 2) assert.ok(lines.some(([level, line]) => level === 'debug' && line.includes('"CMD":"LOGIN"')));
    }
});
