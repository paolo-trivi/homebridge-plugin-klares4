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
