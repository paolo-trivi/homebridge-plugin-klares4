const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DebugCaptureManager } = require('../dist/debug-capture/index.js');
const { DeviceListService } = require('../dist/platform/device-list-service.js');
const { DiscoveryService } = require('../dist/platform/discovery-service.js');
const { PlatformLifecycleService } = require('../dist/platform/platform-lifecycle-service.js');

const log = { info() {}, warn() {}, error() {}, debug() {} };

function tempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeWsClient() {
    return {
        getAllDevices: () => [{ id: 'light_1', type: 'light', name: 'Luce Test', status: { on: true } }],
        addRawMessageListener: () => () => undefined,
    };
}

test('F36: debug capture timers do not keep the process alive', () => {
    const manager = new DebugCaptureManager(log, tempDir('klares4-f36-'));
    manager.startCapture(fakeWsClient(), 600000);
    try {
        assert.equal(manager.captureTimer.hasRef(), false);
        assert.equal(manager.snapshotInterval.hasRef(), false);
    } finally {
        manager.shutdown();
    }
});

test('F36: shutdown stops the capture and writes the debug file before returning', () => {
    const dir = tempDir('klares4-f36-');
    const manager = new DebugCaptureManager(log, dir);
    manager.startCapture(fakeWsClient(), 600000);
    manager.shutdown();

    const files = fs.readdirSync(dir).filter((f) => f.startsWith('klares4-debug-') && f.endsWith('.json'));
    assert.equal(files.length, 1);
    const data = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.deepEqual(data.deviceSnapshots.map((s) => s.label), ['START', 'END']);
    assert.equal(manager.captureTimer, undefined);
    assert.equal(manager.snapshotInterval, undefined);
    manager.shutdown(); // idempotent
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('klares4-debug-')).length, 1);
});

function deviceListService(dir) {
    const config = { devicesSummaryDelay: 600000 };
    return new DeviceListService({
        log,
        storagePath: dir,
        config,
        discoveryService: new DiscoveryService(config, log),
        lifecycleService: new PlatformLifecycleService(log),
    });
}

test('F36: flush on shutdown writes the pending device list and cancels the timer', () => {
    const dir = tempDir('klares4-f36-');
    const service = deviceListService(dir);
    service.saveDevicesList([{ id: 'light_1', type: 'light', name: 'Luce Test', status: {} }]);
    service.flush();

    assert.equal(service.writeTimer, undefined);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'klares4-devices.json'), 'utf8'));
    assert.equal(saved.outputs[0].fullId, 'light_1');
    assert.deepEqual(fs.readdirSync(dir), ['klares4-devices.json']);
});

test('F36: the debounced device list write is atomic', async () => {
    const dir = tempDir('klares4-f36-');
    const service = deviceListService(dir);
    const renames = [];
    const originalRename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
        renames.push([from, to]);
        return originalRename(from, to);
    };
    try {
        service.saveDevicesList([{ id: 'zone_2', type: 'zone', name: 'Zona Test', status: {} }]);
        await new Promise((resolve) => setTimeout(resolve, 1300));
    } finally {
        fs.promises.rename = originalRename;
    }
    assert.deepEqual(renames.map(([, to]) => to), [path.join(dir, 'klares4-devices.json')]);
});
