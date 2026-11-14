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

// ---------------------------------------------------------------------------
// isolation from other plugins sharing the Homebridge process (F18)
// ---------------------------------------------------------------------------

test('telemetry keeps its own client when another plugin calls Sentry.init afterwards', async () => {
  const Sentry = require('@sentry/node');
  const foreign = [];
  _resetForTesting();
  resetTransport();

  initTelemetry(true, '1.0.0');
  Sentry.init({
    dsn: 'https://public@o0.ingest.example.invalid/1',
    defaultIntegrations: false,
    skipOpenTelemetrySetup: true,
    transport: () => ({
      send: async (envelope) => {
        foreign.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });

  captureError(new Error('klares4 error'));
  Sentry.captureException(new Error('other plugin error'));
  await Sentry.flush(2000);
  await closeTelemetry();
  await Sentry.close(2000);

  const ours = sentEvents().map((event) => event.exception.values[0].value);
  const theirs = foreign
    .flatMap(([, items]) => items)
    .filter(([header]) => header.type === 'event')
    .map(([, event]) => event.exception.values[0].value);
  assert.deepEqual(ours, ['klares4 error'], 'klares4 events must reach only the klares4 client');
  assert.deepEqual(theirs, ['other plugin error'], 'other plugins must never receive klares4 events');
  _resetForTesting();
});

test('initTelemetry does not install a process-global Sentry client', async () => {
  const Sentry = require('@sentry/node');
  _resetForTesting();
  resetTransport();
  const before = Sentry.getClient();
  initTelemetry(true, '1.0.0');
  assert.equal(Sentry.getClient(), before, 'the global Sentry client must be left untouched');
  await closeTelemetry();
});

test('sanitizeEventData scrubs tags merged from a shared global scope', () => {
  _resetForTesting();
  const event = { tags: { host: 'lares.local', note: 'seen at 10.0.0.7', component: 'ws' } };
  const result = sanitizeEventData(event);
  assert.equal(result.tags.host, undefined);
  assert.equal(result.tags.note, 'seen at [ip]');
  assert.equal(result.tags.component, 'ws');
});

// ---------------------------------------------------------------------------
// stack frame paths (home directories carry the user name)
// ---------------------------------------------------------------------------

function frameEvent(paths) {
  return {
    exception: { values: [{
      type: 'Error',
      value: 'x',
      stacktrace: { frames: paths.map((p) => ({ filename: p, abs_path: p, function: 'f' })) },
    }] },
  };
}

test('sanitizeEventData keeps only the part after node_modules/ in frame paths', () => {
  const result = sanitizeEventData(frameEvent([
    '/home/mario/.homebridge/node_modules/homebridge-plugin-klares4/dist/platform/index.js',
    '/var/lib/homebridge/node_modules/homebridge/node_modules/ws/lib/websocket.js',
    'C:\\Users\\mario\\AppData\\Roaming\\npm\\node_modules\\homebridge\\dist\\api.js',
  ]));
  const frames = result.exception.values[0].stacktrace.frames;
  assert.deepEqual(frames.map((f) => f.filename), [
    'homebridge-plugin-klares4/dist/platform/index.js',
    'ws/lib/websocket.js',
    'homebridge/dist/api.js',
  ]);
  assert.deepEqual(frames.map((f) => f.abs_path), frames.map((f) => f.filename));
});

test('sanitizeEventData makes plugin paths relative and reduces other absolute paths to the file name', () => {
  const path = require('node:path');
  const pluginRoot = path.resolve(__dirname, '..');
  const result = sanitizeEventData(frameEvent([
    path.join(pluginRoot, 'dist', 'telemetry.js'),
    '/Users/mario/scripts/start.js',
    'file:///home/mario/app/main.mjs',
    'node:internal/modules/cjs/loader',
    'events.js',
  ]));
  assert.deepEqual(result.exception.values[0].stacktrace.frames.map((f) => f.filename), [
    'homebridge-plugin-klares4/dist/telemetry.js',
    'start.js',
    'main.mjs',
    'node:internal/modules/cjs/loader',
    'events.js',
  ]);
});

test('sanitizeEventData replaces the home directory in message text', () => {
  const os = require('node:os');
  const home = os.homedir();
  const result = sanitizeEventData({
    message: `ENOENT: no such file or directory, open '${home}/.homebridge/klares4.json'`,
  });
  assert.ok(!result.message.includes(home), result.message);
  assert.ok(result.message.includes('~/.homebridge/klares4.json'), result.message);
});

test('events sent through the transport carry no absolute stack paths', async () => {
  const os = require('node:os');
  _resetForTesting();
  resetTransport();
  initTelemetry(true, '1.0.0');
  captureError(new Error('with a stack'));
  await closeTelemetry();

  const [event] = sentEvents();
  const frames = event.exception.values[0].stacktrace.frames;
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    for (const value of [frame.filename, frame.abs_path, frame.module]) {
      if (value === undefined) continue;
      assert.ok(!value.startsWith('/'), `absolute path in frame: ${value}`);
      assert.ok(!value.includes(os.homedir()), `home directory in frame: ${value}`);
    }
  }
  _resetForTesting();
});
