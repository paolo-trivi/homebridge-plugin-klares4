const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { DeviceListService } = require('../dist/platform/device-list-service.js');
const { DiscoveryService } = require('../dist/platform/discovery-service.js');
const { buildRoomMappingExample } = require('../dist/platform/room-mapping-example.js');
const { startMockPanel } = require('./fixtures/lares4-mock-panel.js');
const { createPlatform } = require('./fixtures/platform-session-harness.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');
const { waitFor } = require('./fixtures/wait-for.js');

const device = (id, type, name) => ({ id, type, name, description: '', status: {} });
const DEVICES = [
    device('light_5', 'light', 'Light A'),
    device('light_6', 'light', 'Light B'),
    device('zone_1', 'zone', 'Zone One'),
    device('sensor_temp_1', 'sensor', 'Domus - Temperature'),
    device('scenario_1', 'scenario', 'Evening'),
];

function makeService(t, { config = {}, existingExample } = {}) {
    const storagePath = tmpStorage(t, 'klares4-devlist-');
    const lines = [];
    const log = { info: (m) => lines.push(`INFO ${m}`), warn: (m) => lines.push(`WARN ${m}`), error: (...a) => lines.push(`ERROR ${a.join(' ')}`), debug() {} };
    const summaries = [];
    // Runs the summary at once, as the debounce timer would after the delay.
    const lifecycleService = { scheduleSummary: (callback) => { summaries.push(callback); callback(); } };
    const service = new DeviceListService({ log, storagePath, config, discoveryService: new DiscoveryService(config, log), lifecycleService });
    if (existingExample !== undefined) fs.writeFileSync(path.join(storagePath, 'klares4-room-mapping-example.json'), existingExample);
    return { service, storagePath, lines, summaries };
}

const banners = (lines) => lines.filter((line) => /AVAILABLE DEVICES/.test(line)).length;
const exampleLogs = (lines) => lines.filter((line) => /Room mapping example/.test(line));
const examplePath = (dir) => path.join(dir, 'klares4-room-mapping-example.json');

test('PLAT-14: the same list handed over again prints and writes nothing', async (t) => {
    const { service, storagePath, lines, summaries } = makeService(t);
    service.saveDevicesList(DEVICES);
    await waitFor(() => exampleLogs(lines).length === 1);

    for (let i = 0; i < 3; i += 1) service.saveDevicesList([...DEVICES]);
    service.flush();

    assert.equal(summaries.length, 1, 'the summary is scheduled once');
    assert.equal(banners(lines), 1);
    assert.equal(exampleLogs(lines).length, 1);
    assert.ok(fs.existsSync(examplePath(storagePath)));
});

test('PLAT-14: a change in the list (a rename) prints the summary again and updates the example', async (t) => {
    const { service, lines } = makeService(t);
    service.saveDevicesList(DEVICES);
    await waitFor(() => exampleLogs(lines).length === 1);

    service.saveDevicesList(DEVICES.map((entry) => (entry.id === 'light_5' ? { ...entry, name: 'Light A renamed' } : entry)));
    await waitFor(() => exampleLogs(lines).length === 2);

    assert.equal(banners(lines), 2);
    assert.match(exampleLogs(lines)[0], /created/);
    assert.match(exampleLogs(lines)[1], /updated/);
});

test('PLAT-14: an example file that already holds the same content is not rewritten', async (t) => {
    const { service, storagePath, lines } = makeService(t);
    fs.writeFileSync(examplePath(storagePath), buildRoomMappingExample(service['buildDevicesList'](DEVICES)));
    const writes = [];
    const originalOpen = fs.promises.open;
    fs.promises.open = async (target, flags, ...rest) => {
        if (flags === 'wx') writes.push(path.basename(target));
        return originalOpen(target, flags, ...rest);
    };
    t.after(() => { fs.promises.open = originalOpen; });

    service.saveDevicesList(DEVICES);
    // A real change afterwards: its write is the only one, and by then the first comparison is done.
    service.saveDevicesList(DEVICES.map((entry) => (entry.id === 'zone_1' ? { ...entry, name: 'Zone renamed' } : entry)));
    await waitFor(() => exampleLogs(lines).length === 1);

    assert.match(exampleLogs(lines)[0], /updated/);
    assert.equal(writes.filter((name) => name.startsWith('klares4-room-mapping-example.json')).length, 1);
});

test('PLAT-14: the example is written atomically: private mode, no temporary file left', async (t) => {
    const { service, storagePath, lines } = makeService(t);
    service.saveDevicesList(DEVICES);
    await waitFor(() => exampleLogs(lines).length === 1);
    service.flush();

    assert.equal(fs.statSync(examplePath(storagePath)).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(storagePath).filter((name) => name.endsWith('.tmp')), []);
    const example = JSON.parse(fs.readFileSync(examplePath(storagePath), 'utf8'));
    assert.deepEqual(example.roomMapping.rooms.map((room) => room.roomName), ['sala', 'cucina', 'camera']);
});

test('PLAT-14: the example content is the one the service always produced', () => {
    const list = {
        zones: [{ id: '1', name: 'Zone One', type: 'zone', description: '', fullId: 'zone_1' }],
        outputs: ['A', 'B', 'C', 'D', 'E'].map((name, i) => ({ id: String(i), name, type: 'light', description: '', fullId: `light_${i}` })),
        sensors: ['S1', 'S2', 'S3'].map((name, i) => ({ id: String(i), name, type: 'sensor', description: '', fullId: `sensor_temp_${i}` })),
        scenarios: [],
        lastUpdated: 'x',
    };
    const example = JSON.parse(buildRoomMappingExample(list));
    const ids = (room) => example.roomMapping.rooms.find((entry) => entry.roomName === room).devices.map((entry) => entry.deviceId);
    assert.deepEqual(ids('sala'), ['sensor_temp_0', 'sensor_temp_1', 'light_0']);
    assert.deepEqual(ids('cucina'), ['light_1', 'light_2']);
    assert.deepEqual(ids('camera'), ['zone_1', 'light_3']);
    assert.equal(example._availableDevices.outputs.length, 5);
});

test('PLAT-14: after reconnections the platform prints one summary, not one per login', async (t) => {
    const panel = await startMockPanel();
    t.after(() => panel.close());
    const { platform, api, log } = createPlatform(t, { port: panel.port, config: { devicesSummaryDelay: 500 } });
    const syncs = () => log.lines.filter((line) => /Initial synchronization completed/.test(line)).length;
    api.emit('didFinishLaunching');
    await waitFor(() => syncs() === 1);
    await waitFor(() => banners(log.lines) === 1);
    await waitFor(() => exampleLogs(log.lines).length === 1);

    for (const expected of [2, 3]) {
        panel.dropConnections();
        await waitFor(() => syncs() === expected);
        // The summary timer is only armed by a change in the list.
        assert.equal(platform['lifecycleService']['summaryTimeout'], undefined, `no summary pending after sync ${expected}`);
    }

    assert.equal(banners(log.lines), 1);
    assert.equal(exampleLogs(log.lines).length, 1);
});
