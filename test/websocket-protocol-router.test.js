const test = require('node:test');
const assert = require('node:assert/strict');

const { ProtocolRouter } = require('../dist/websocket/protocol-router.js');

function createMessage(cmd, payloadType = 'UNKNOWN') {
  return {
    SENDER: 'hb',
    RECEIVER: '',
    CMD: cmd,
    ID: '1',
    PAYLOAD_TYPE: payloadType,
    PAYLOAD: {},
    TIMESTAMP: '0',
    CRC_16: '0x0000',
  };
}

test('ProtocolRouter dispatches known commands and response callback', () => {
  const events = [];
  const router = new ProtocolRouter({
    onResponseMessage: () => events.push('response'),
    onLoginResponse: () => events.push('login'),
    onReadResponse: () => events.push('read'),
    onRealtimeResponse: () => events.push('realtime-res'),
    onStatusUpdate: () => events.push('status'),
    onPing: () => events.push('ping'),
    onUnhandled: () => events.push('unhandled'),
  });

  router.route(createMessage('LOGIN_RES'));
  router.route(createMessage('READ_RES'));
  router.route(createMessage('REALTIME_RES'));
  router.route(createMessage('REALTIME', 'CHANGES'));
  router.route(createMessage('STATUS_UPDATE'));
  router.route(createMessage('PING'));
  router.route(createMessage('UNKNOWN_CMD'));

  assert.deepEqual(events, [
    'response', 'login',
    'response', 'read',
    'response', 'realtime-res',
    'status',
    'status',
    'ping',
    'unhandled',
  ]);
});

test('ProtocolRouter forwards explicit panel failures to pending commands', () => {
  const events = [];
  const router = new ProtocolRouter({
    onResponseMessage: () => events.push('response'),
    onLoginResponse: () => undefined,
    onReadResponse: () => undefined,
    onRealtimeResponse: () => undefined,
    onStatusUpdate: () => undefined,
    onUnhandled: () => events.push('unhandled'),
  });
  const message = createMessage('GENERIC', 'ERROR');
  message.PAYLOAD = { RESULT: 'FAIL', RESULT_DETAIL: 'CMD_NOT_AVAILABLE' };

  router.route(message);

  assert.deepEqual(events, ['response', 'unhandled']);
});
