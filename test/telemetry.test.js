const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeEventData,
  initTelemetry,
  captureError,
  captureMessage,
  closeTelemetry,
  _resetForTesting,
  _setTransportForTesting,
} = require('../dist/telemetry.js');

// ---------------------------------------------------------------------------
// Mock transport: no test may ever reach the production Sentry project.
// Installed before any initTelemetry call and never removed.
// ---------------------------------------------------------------------------

const transport = { created: 0, envelopes: [] };
_setTransportForTesting(() => {
  transport.created += 1;
  return {
    send: async (envelope) => {
      transport.envelopes.push(envelope);
      return { statusCode: 200 };
    },
    flush: async () => true,
  };
});

function resetTransport() {
  transport.created = 0;
  transport.envelopes.length = 0;
}

/** Event payloads (not sessions or client reports) handed to the transport. */
function sentEvents() {
  const events = [];
  for (const [, items] of transport.envelopes) {
    for (const [header, payload] of items) {
      if (header.type === 'event') events.push(payload);
    }
  }
  return events;
}

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

test('telemetry:false never creates a transport nor sends anything', async () => {
  _resetForTesting();
  resetTransport();
  initTelemetry(false, '1.0.0', ['lares.local']);
  captureError(new Error('should be ignored'));
  captureMessage('should be ignored', 'error');
  await closeTelemetry();
  assert.equal(transport.created, 0);
  assert.equal(transport.envelopes.length, 0);
});

test('enabled telemetry sends only sanitized events through the transport', async () => {
  _resetForTesting();
  resetTransport();
  initTelemetry(true, '9.9.9-test', ['lares.local', '123456']);
  captureError(
    new Error('connect ECONNREFUSED 192.168.1.10:443 (lares.local, pin 123456)'),
    { context: 'initializeLares4', host: 'lares.local' },
  );
  captureMessage('ws closed by wss://192.168.1.10/KseniaWsock', 'warning');
  await closeTelemetry();

  const events = sentEvents();
  assert.equal(events.length, 2, `expected 2 events, got ${events.length}`);
  const serialized = JSON.stringify(events);
  for (const secret of ['192.168.1.10', 'lares.local', '123456', 'KseniaWsock']) {
    assert.ok(!serialized.includes(secret), `event leaks ${secret}: ${serialized}`);
  }
  const errorEvent = events.find((event) => event.exception);
  assert.equal(errorEvent.exception.values[0].value, 'connect ECONNREFUSED [ip] ([redacted], pin [redacted])');
  assert.equal(errorEvent.extra.context, 'initializeLares4');
  assert.equal(errorEvent.extra.host, undefined);
  assert.equal(errorEvent.server_name, undefined);
  assert.equal(errorEvent.release, 'homebridge-plugin-klares4@9.9.9-test');
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// value-level scrubbing (panel IP/host must never leave the process)
// ---------------------------------------------------------------------------

test('sanitizeEventData scrubs IPs and URLs from error messages', () => {
  _resetForTesting();
  const event = {
    message: 'Connecting to wss://192.168.1.10:443/KseniaWsock failed',
    exception: { values: [
      { type: 'Error', value: 'connect ECONNREFUSED 192.168.1.10:443' },
      { type: 'Error', value: 'plain error without addresses' },
    ] },
  };
  const result = sanitizeEventData(event);
  assert.ok(!result.message.includes('192.168.1.10'), `message still leaks the IP: ${result.message}`);
  assert.equal(result.exception.values[0].value, 'connect ECONNREFUSED [ip]');
  assert.equal(result.exception.values[1].value, 'plain error without addresses');
});

test('sanitizeEventData scrubs configured sensitive values (panel host, PIN)', () => {
  _resetForTesting();
  initTelemetry(false, '1.0.0', ['lares.local', '123456']);
  const event = {
    exception: { values: [{ type: 'Error', value: 'getaddrinfo ENOTFOUND lares.local (pin 123456)' }] },
  };
  const result = sanitizeEventData(event);
  assert.ok(!result.exception.values[0].value.includes('lares.local'));
  assert.ok(!result.exception.values[0].value.includes('123456'));
  _resetForTesting();
});

test('sanitizeEventData removes server_name (machine hostname)', () => {
  const event = { server_name: 'raspberrypi.lan', message: 'x' };
  const result = sanitizeEventData(event);
  assert.equal(result.server_name, undefined);
});

test('sanitizeEventData scrubs string values in extra and breadcrumb messages', () => {
  _resetForTesting();
  const event = {
    extra: { detail: 'ws error at 10.0.0.7:80' },
    breadcrumbs: [{ message: 'opened wss://10.0.0.7/KseniaWsock' }],
  };
  const result = sanitizeEventData(event);
  assert.equal(result.extra.detail, 'ws error at [ip]');
  assert.ok(!result.breadcrumbs[0].message.includes('10.0.0.7'));
});

test('sanitizeEventData strips compound sensitive keys (ipAddress, hostname, deviceName)', () => {
  const event = { extra: { ipAddress: '10.0.0.9', hostname: 'lares.lan', deviceName: 'Camera', step: 'x' } };
  const result = sanitizeEventData(event);
  assert.equal(result.extra.ipAddress, undefined);
  assert.equal(result.extra.hostname, undefined);
  assert.equal(result.extra.deviceName, undefined);
  assert.equal(result.extra.step, 'x');
});
