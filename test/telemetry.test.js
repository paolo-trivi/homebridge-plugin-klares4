const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeEventData,
  initTelemetry,
  captureError,
  captureMessage,
  closeTelemetry,
  _resetForTesting,
} = require('../dist/telemetry.js');

// ---------------------------------------------------------------------------
// sanitizeEventData
// ---------------------------------------------------------------------------

test('sanitizeEventData removes event.user', () => {
  const event = { user: { id: '123', email: 'a@b.com' }, message: 'test' };
  const result = sanitizeEventData(event);
  assert.equal(result.user, undefined);
  assert.equal(result.message, 'test');
});

test('sanitizeEventData removes event.request', () => {
  const event = { request: { url: 'http://x', headers: {} }, message: 'ok' };
  const result = sanitizeEventData(event);
  assert.equal(result.request, undefined);
});

test('sanitizeEventData strips sensitive keys from extra', () => {
  const event = {
    extra: {
      pin: '1234',
      password: 'secret',
      token: 'abc',
      secret: 'xyz',
      ip: '192.168.1.1',
      host: 'panel.local',
      url: 'wss://panel.local',
      sender: 'homebridge',
      config: { full: true },
      payload: '{"big":"data"}',
      name: 'Camera Cucina',
      room: 'Cucina',
      device: 'zone_1',
      errorCode: 42,
      context: 'initializeLares4',
    },
  };
  const result = sanitizeEventData(event);
  // sensitive keys removed
  assert.equal(result.extra.pin, undefined);
  assert.equal(result.extra.password, undefined);
  assert.equal(result.extra.token, undefined);
  assert.equal(result.extra.secret, undefined);
  assert.equal(result.extra.ip, undefined);
  assert.equal(result.extra.host, undefined);
  assert.equal(result.extra.url, undefined);
  assert.equal(result.extra.sender, undefined);
  assert.equal(result.extra.config, undefined);
  assert.equal(result.extra.payload, undefined);
  assert.equal(result.extra.name, undefined);
  assert.equal(result.extra.room, undefined);
  assert.equal(result.extra.device, undefined);
  // safe keys preserved
  assert.equal(result.extra.errorCode, 42);
  assert.equal(result.extra.context, 'initializeLares4');
});

test('sanitizeEventData handles missing extra gracefully', () => {
  const event = { message: 'no extra' };
  const result = sanitizeEventData(event);
  assert.equal(result.message, 'no extra');
  assert.equal(result.extra, undefined);
});

test('sanitizeEventData strips sensitive keys from contexts', () => {
  const event = {
    contexts: {
      connection: { ip: '10.0.0.1', protocol: 'wss' },
      auth: { pin: '9999', method: 'pin' },
    },
  };
  const result = sanitizeEventData(event);
  assert.equal(result.contexts.connection.ip, undefined);
  assert.equal(result.contexts.connection.protocol, 'wss');
  assert.equal(result.contexts.auth.pin, undefined);
  assert.equal(result.contexts.auth.method, 'pin');
});

test('sanitizeEventData strips sensitive keys from breadcrumbs', () => {
  const event = {
    breadcrumbs: [
      { data: { url: 'wss://panel', action: 'connect' } },
      { data: { token: 'xyz', step: 'auth' } },
      { message: 'no data field' },
    ],
  };
  const result = sanitizeEventData(event);
  assert.equal(result.breadcrumbs[0].data.url, undefined);
  assert.equal(result.breadcrumbs[0].data.action, 'connect');
  assert.equal(result.breadcrumbs[1].data.token, undefined);
  assert.equal(result.breadcrumbs[1].data.step, 'auth');
});

// ---------------------------------------------------------------------------
// telemetry disabled (default)
// ---------------------------------------------------------------------------

test('initTelemetry with false does not initialize', () => {
  _resetForTesting();
  // should not throw
  initTelemetry(false, '1.0.0');
  // captureError should be a no-op
  captureError(new Error('should be ignored'));
  captureMessage('should be ignored');
  closeTelemetry();
});

test('initTelemetry with undefined initializes (opt-out default)', () => {
  _resetForTesting();
  // should not throw
  initTelemetry(undefined, '1.0.0');
});

// ---------------------------------------------------------------------------
// telemetry enabled
// ---------------------------------------------------------------------------

test('initTelemetry with true initializes without error', () => {
  _resetForTesting();
  // should not throw
  initTelemetry(true, '2.1.4-rc.4');
});

test('captureError does not throw when initialized', () => {
  // relies on previous test having initialized
  captureError(new Error('test error'));
  captureError(new Error('test with context'), { context: 'test' });
});

test('captureMessage does not throw when initialized', () => {
  captureMessage('test message');
  captureMessage('test warning', 'warning');
});

test('closeTelemetry does not throw', () => {
  closeTelemetry();
  _resetForTesting();
});

test('closeTelemetry is safe to call when not initialized', () => {
  _resetForTesting();
  closeTelemetry(); // should not throw
});
