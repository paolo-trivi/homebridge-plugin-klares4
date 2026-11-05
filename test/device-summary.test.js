const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DeviceListService } = require('../dist/platform/device-list-service.js');
const { DiscoveryService } = require('../dist/platform/discovery-service.js');
const { PlatformLifecycleService } = require('../dist/platform/platform-lifecycle-service.js');

const DEVICES = [
    { id: 'light_37', type: 'light', name: 'Luce Test', status: {} },
    { id: 'thermostat_18', type: 'thermostat', name: 'Termostato Test', status: {} },
    { id: 'zone_4', type: 'zone', name: 'Zona Test', status: {} },
    { id: 'sensor_temp_5', type: 'sensor', name: 'Sala - Temperatura', status: {} },
    { id: 'sensor_system_temp_in', type: 'sensor', name: 'Temperatura Interna', status: {} },
    { id: 'scenario_9', type: 'scenario', name: 'Scenario Test', status: {} },
];

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));

const EXCLUDE_KEY = { light: 'excludeOutputs', thermostat: 'excludeOutputs', zone: 'excludeZones', sensor: 'excludeSensors', scenario: 'excludeScenarios' };

test('device summary prints the ID each exclusion list actually accepts', () => {
    const lines = [];
    const log = { info: (m) => lines.push(m), warn() {}, error() {}, debug() {} };
    const config = {};
    const service = new DeviceListService({
        log,
        storagePath: fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-summary-')),
        config,
        discoveryService: new DiscoveryService(config, log),
        lifecycleService: new PlatformLifecycleService(log),
    });
    service['printDevicesSummary'](service['buildDevicesList'](DEVICES));

    for (const device of DEVICES) {
        const line = lines.find((l) => l.includes(device.name));
        assert.ok(line, `summary line for ${device.id}`);
        assert.ok(line.includes(device.id), `full ID shown for ${device.id}: ${line}`);
        const match = /exclude: (\S+)/.exec(line);
        assert.ok(match, `exclusion ID shown for ${device.id}: ${line}`);
        const discovery = new DiscoveryService({ [EXCLUDE_KEY[device.type]]: [match[1]] }, log);
        assert.equal(discovery.isDeviceExcluded(device), true, `${match[1]} excludes ${device.id}`);
        const pattern = new RegExp(schema.schema.properties[EXCLUDE_KEY[device.type]].items.pattern);
        assert.match(match[1], pattern, `the UI accepts ${match[1]} in ${EXCLUDE_KEY[device.type]}`);
    }
});
