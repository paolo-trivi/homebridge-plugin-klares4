const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const hap = require('@homebridge/hap-nodejs');

const { Lares4Platform } = require('../dist/platform/index.js');

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, success() {} };

function fakeApi(storagePath) {
    const listeners = new Map();
    return {
        hap,
        user: { storagePath: () => storagePath },
        platformAccessory: class {},
        registerPlatformAccessories() {},
        unregisterPlatformAccessories() {},
        on(event, callback) { listeners.set(event, callback); },
        emit(event) { return listeners.get(event)?.(); },
    };
}

// A local port nobody listens on: the panel is offline at boot.
function closedPort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

test('MQTT bridge starts even when the panel is unreachable at boot', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-startup-'));
    const api = fakeApi(storagePath);
    const platform = new Lares4Platform(silentLog, {
        platform: 'Lares4Complete',
        ip: '127.0.0.1',
        port: await closedPort(),
        https: false,
        pin: '123456',
        telemetry: false,
        reconnectInterval: 60_000,
        mqtt: { enabled: true, broker: `mqtt://127.0.0.1:${await closedPort()}` },
    }, api);
    try {
        api.emit('didFinishLaunching');
        for (let i = 0; i < 100 && !platform.mqttBridge; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(platform.mqttBridge, 'MQTT bridge must not depend on the first WebSocket connect succeeding');
    } finally {
        api.emit('shutdown');
    }
});

test('F36/F17: shutdown during a debug capture writes the file; the flag resets on the qualified name', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-startup-'));
    const platformConfig = {
        platform: 'homebridge-plugin-klares4.Lares4Complete',
        ip: '127.0.0.1',
        port: await closedPort(),
        https: false,
        pin: '123456',
        telemetry: false,
        reconnectInterval: 60_000,
        generateDebugFile: true,
        debugCaptureDurationMs: 600_000,
    };
    fs.writeFileSync(path.join(storagePath, 'config.json'), `${JSON.stringify({ platforms: [platformConfig] }, null, 4)}\n`);
    const api = fakeApi(storagePath);
    const platform = new Lares4Platform(silentLog, { ...platformConfig }, api);
    const flagReset = () => JSON.parse(fs.readFileSync(path.join(storagePath, 'config.json'), 'utf8')).platforms[0].generateDebugFile === false;
    try {
        api.emit('didFinishLaunching');
        for (let i = 0; i < 100 && !(platform.debugCapture && flagReset()); i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(platform.debugCapture, 'debug capture started');
        assert.ok(flagReset(), 'generateDebugFile reset in config.json');
    } finally {
        api.emit('shutdown');
    }
    const debugFiles = fs.readdirSync(storagePath).filter((f) => /^klares4-debug-.*\.json$/.test(f));
    assert.equal(debugFiles.length, 1, 'the capture is flushed synchronously on shutdown');
});
