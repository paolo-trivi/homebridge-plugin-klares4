const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { refreshKsaSections, resolveRuntimeConfig } = require('../dist/platform/runtime-config.js');
const { createPlatform } = require('./fixtures/platform-session-harness.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');
const { waitFor } = require('./fixtures/wait-for.js');

function quietLog() {
    const lines = [];
    const add = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
    return { lines, info: add('INFO'), warn: add('WARN'), error: add('ERROR'), debug() {} };
}

/** A port nobody listens on: the panel is offline, only the start-up matters here. */
function closedPort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function ksaFile(dir) {
    const file = path.join(dir, 'panel.ksa');
    const data = { PRG_OUTPUTS: [{ ID: '18', DES: 'Heating', CAT: 'THERMO' }], PRG_THERMOSTATS: [{ ID: '3', HEATING_OUT: '18', PERIPH: { PID: '2' } }] };
    fs.writeFileSync(file, Buffer.concat([Buffer.from('KSFS\x03\x00'), Buffer.from(JSON.stringify({ INFO: {}, DATA: data }))]));
    return file;
}

const count = (lines, pattern) => lines.filter((line) => pattern.test(line)).length;

test('an invalid value is reported once at startup when the KSA import is active', async (t) => {
    const ksaPath = ksaFile(tmpStorage(t, 'klares4-ksa-file-'));
    const { platform, api, log } = createPlatform(t, {
        port: await closedPort(),
        config: {
            reconnectInterval: 60_000,
            maxSeconds: 3,
            excludeZones: 5,
            ksaImport: { enabled: true, filePath: ksaPath },
            telemetry: true,
        },
    });
    api.emit('didFinishLaunching');
    await waitFor(() => platform.wsClient !== undefined);

    assert.equal(count(log.lines, /Configuration: \d+ value\(s\) ignored or adjusted/), 1, log.lines.join('\n'));
    assert.equal(count(log.lines, /maxSeconds: 3 is below the minimum/), 1);
    assert.equal(count(log.lines, /telemetry/), 1, 'the informative line is not repeated either');
    // The import still reached the runtime config the platform uses.
    assert.deepEqual(platform.runtimeConfig.domusThermostat.manualCommandPairs, [{ thermostatOutputId: '18', commandThermostatId: '3' }]);
    assert.equal(platform.runtimeConfig.maxSeconds, 5);
});

test('reading the KSA sections again reports only what the import introduced', () => {
    const first = quietLog();
    const raw = { platform: 'x', ip: '192.0.2.1', pin: '1', maxSeconds: 3, https: 'yes', domusThermostat: { enabled: true } };
    const runtime = resolveRuntimeConfig(raw, first);
    assert.equal(first.lines.length, 1);

    const second = quietLog();
    const refreshed = refreshKsaSections(runtime, raw, second);
    assert.deepEqual(second.lines, [], 'maxSeconds and https are not reported again');
    assert.equal(refreshed.maxSeconds, 5);
    assert.equal(refreshed.https, true);

    const third = quietLog();
    const afterImport = refreshKsaSections(runtime, {
        ...raw,
        domusThermostat: { manualCommandPairs: [{ thermostatOutputId: '18' }, { thermostatOutputId: '19', commandThermostatId: '4' }] },
        customNames: [{ deviceId: 'zone_1', name: 'Door' }],
        ksaImport: { enabled: true, applyAtStartup: false },
    }, third);
    assert.equal(count(third.lines, /manualCommandPairs\[0\]/), 1);
    assert.deepEqual(afterImport.domusThermostat.manualCommandPairs, [{ thermostatOutputId: '19', commandThermostatId: '4' }]);
    assert.equal(afterImport.customNames.zones['1'], 'Door');
    assert.equal(afterImport.ksaImport.applyAtStartup, false);
    assert.equal(afterImport.maxSeconds, 5);
});

test('PLAT-16: a start removes the stale temporary files of the storage directory', async (t) => {
    const { platform, api, storagePath } = createPlatform(t, { port: await closedPort(), config: { reconnectInterval: 60_000 } });
    const orphan = path.join(storagePath, 'config.json.4242.0a1b2c3d4e5f.tmp');
    fs.writeFileSync(orphan, '{"pin":"000000"}');
    const old = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(orphan, old, old);

    api.emit('didFinishLaunching');
    await waitFor(() => platform.wsClient !== undefined);

    assert.equal(fs.existsSync(orphan), false);
});

test('PLAT-07: with two platform blocks the debug flag is switched off in the block of this instance', async (t) => {
    const { platform, api, storagePath } = createPlatform(t, {
        port: await closedPort(),
        config: { name: 'House B', generateDebugFile: true, reconnectInterval: 60_000 },
    });
    const file = path.join(storagePath, 'config.json');
    const blocks = [
        { platform: 'Lares4Complete', name: 'House A', ip: '192.0.2.1', generateDebugFile: true },
        { platform: 'Lares4Complete', name: 'House B', ip: '127.0.0.1', generateDebugFile: true },
    ];
    fs.writeFileSync(file, JSON.stringify({ platforms: blocks }, null, 4));

    api.emit('didFinishLaunching');
    await waitFor(() => platform.wsClient !== undefined);
    await waitFor(() => JSON.parse(fs.readFileSync(file, 'utf8')).platforms[1].generateDebugFile === false);

    const written = JSON.parse(fs.readFileSync(file, 'utf8')).platforms;
    assert.equal(written[0].generateDebugFile, true);
});
