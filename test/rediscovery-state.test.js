const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');
const { StatusUpdater } = require('../dist/websocket-client/status-updater.js');
const { SystemTemperatureUpdater } = require('../dist/websocket-client/system-temperature-updater.js');
const { ThermostatStatusUpdater } = require('../dist/websocket-client/thermostat-status-updater.js');
const { MessageService } = require('../dist/websocket-client/message-service.js');

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

// Synthetic panel: one light, one cover, one DOMUS sensor, one zone.
const MULTI_TYPES = {
    OUTPUTS: [
        { ID: '5', DES: 'Faretti', CAT: 'LIGHT' },
        { ID: '7', DES: 'Tapparella Test', CAT: 'ROLL' },
    ],
    BUS_HAS: [{ ID: '1', DES: 'Term. Test', TYP: 'DOMUS', ENABLED: 'YES' }],
};
const ZONES = [{ ID: '3', DES: 'Finestra Test', CAT: 'WINDOW' }];

function makePipeline() {
    const state = createInitialWebSocketClientState({ enabled: true, manualPairs: [], sensorFreshnessMs: 300000 });
    const events = [];
    const emitStatus = (device) => events.push({ kind: 'status', id: device.id, status: { ...device.status } });
    const service = new MessageService({
        state,
        callbacks: {
            onDeviceDiscovered: (device) => events.push({ kind: 'discovered', id: device.id, status: { ...device.status } }),
            onDeviceStatusUpdate: emitStatus,
        },
        log,
        logLevel: 1,
        debugEnabled: false,
        statusUpdater: new StatusUpdater({ state, log, logLevel: 1, debugEnabled: false, emitDeviceStatusUpdate: emitStatus }),
        systemTemperatureUpdater: new SystemTemperatureUpdater({
            state, log, logLevel: 1, debugEnabled: false, emitDeviceDiscovered: () => undefined, emitDeviceStatusUpdate: emitStatus,
        }),
        thermostatStatusUpdater: new ThermostatStatusUpdater({ state, emitDeviceStatusUpdate: emitStatus }),
        commandService: { requestSystemData: async () => undefined },
        routeMessage: () => undefined,
        emitRawMessage: () => undefined,
        onLoginCompleted: () => undefined,
    });
    const read = (type, payload) => service.handleReadResponse({ CMD: 'READ_RES', ID: '1', PAYLOAD_TYPE: type, PAYLOAD: payload });
    const discover = () => { read('ZONES', { ZONES }); read('MULTI_TYPES', MULTI_TYPES); };
    const observe = () => {
        read('STATUS_OUTPUTS', { STATUS_OUTPUTS: [{ ID: '5', STA: 'ON' }, { ID: '7', STA: 'STOP', POS: '80' }] });
        read('STATUS_BUS_HA_SENSORS', { STATUS_BUS_HA_SENSORS: [{ ID: '1', DOMUS: { TEM: '21.5', HUM: '48', LHT: '12' } }] });
        service.handleRealtimeResponse({ CMD: 'REALTIME_RES', ID: '2', PAYLOAD_TYPE: 'CHANGES', PAYLOAD: { STATUS_ZONES: [{ ID: '3', STA: 'A', BYP: 'NO' }] } });
    };
    return { state, events, discover, observe };
}

test('F03: a reconnect re-discovery keeps the observed state instead of the parser defaults', () => {
    const p = makePipeline();
    p.discover();
    p.observe();
    assert.equal(p.state.devices.get('light_5').status.on, true);

    p.events.length = 0;
    p.discover(); // every login re-reads ZONES + MULTI_TYPES

    const discovered = Object.fromEntries(p.events.filter((e) => e.kind === 'discovered').map((e) => [e.id, e.status]));
    assert.equal(discovered.light_5.on, true);
    assert.equal(discovered.cover_7.position, 80);
    assert.equal(discovered.sensor_temp_1.value, 21.5);
    assert.equal(discovered.zone_3.open, true);
    assert.equal(p.state.devices.get('light_5').status.on, true);
    assert.equal(p.state.devices.get('cover_7').status.position, 80);
});

test('F03: a renamed device keeps its state and takes the new name', () => {
    const p = makePipeline();
    p.discover();
    p.observe();
    MULTI_TYPES.OUTPUTS[0].DES = 'Faretti Soggiorno';
    try {
        p.discover();
    } finally {
        MULTI_TYPES.OUTPUTS[0].DES = 'Faretti';
    }
    const light = p.state.devices.get('light_5');
    assert.equal(light.name, 'Faretti Soggiorno');
    assert.equal(light.status.on, true);
});

test('F03: freshly parsed devices are flagged as not yet observed until a real status arrives', () => {
    const { KseniaWebSocketClient } = require('../dist/websocket-client/index.js');
    const { hasObservedState } = require('../dist/device-observation.js');
    const client = new KseniaWebSocketClient('127.0.0.1', 1, false, 'hb', '0000', log, {});
    const service = client['messageService'];
    const devices = client['state'].devices;
    const read = (type, payload) => service.handleReadResponse({ CMD: 'READ_RES', ID: '1', PAYLOAD_TYPE: type, PAYLOAD: payload });

    read('MULTI_TYPES', MULTI_TYPES);
    assert.equal(hasObservedState(devices.get('light_5')), false);
    assert.equal(hasObservedState(devices.get('sensor_temp_1')), false);

    read('STATUS_OUTPUTS', { STATUS_OUTPUTS: [{ ID: '5', STA: 'ON' }, { ID: '7', STA: 'STOP', POS: '80' }] });
    read('STATUS_BUS_HA_SENSORS', { STATUS_BUS_HA_SENSORS: [{ ID: '1', DOMUS: { TEM: '21.5', HUM: '48', LHT: '12' } }] });
    assert.equal(hasObservedState(devices.get('light_5')), true);
    assert.equal(hasObservedState(devices.get('cover_7')), true);
    assert.equal(hasObservedState(devices.get('sensor_temp_1')), true);
});

test('F03: at boot a Matter endpoint restored from cache is not overwritten with discovery placeholders', async () => {
    process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '20';
    process.env.KLARES4_MATTER_REGISTER_POLL_MS = '10';
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
    const { markStatusPlaceholder } = require('../dist/device-observation.js');
    const { makeHb24MatterApi, deviceTypes } = require('./fixtures/hb24-matter-api.js');

    const hb = makeHb24MatterApi({
        restored: [{ UUID: 'cover_7', deviceType: deviceTypes.WindowCovering, clusters: { windowCovering: {} } }],
    });
    const registry = new MatterAccessoryRegistry({
        api: hb.api, log: log, getWsClient: () => undefined,
        storagePath: fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-boot-')),
    });
    registry.configureCachedAccessory({
        UUID: 'cover_7', displayName: 'Tapparella Test', deviceType: deviceTypes.WindowCovering,
        context: { device: { id: 'cover_7', type: 'cover', name: 'Tapparella Test', description: '', status: { position: 80, state: 'stopped' } } },
    });

    const placeholder = { id: 'cover_7', type: 'cover', name: 'Tapparella Test', description: '', status: { position: 0, state: 'stopped' } };
    markStatusPlaceholder(placeholder);
    await registry.addOrUpdateAccessory(placeholder);
    await new Promise((r) => setTimeout(r, 200));

    const positions = hb.updates.filter((u) => u.cluster === 'windowCovering').map((u) => u.attributes.currentPositionLiftPercent100ths);
    assert.ok(!positions.includes(10000), `placeholder "closed" pushed to Matter: ${JSON.stringify(positions)}`);
});

test('F03: at boot a cached HomeKit accessory keeps its cached state until the panel reports one', () => {
    const { AccessoryRegistry } = require('../dist/platform/accessory-registry.js');
    const { markStatusPlaceholder } = require('../dist/device-observation.js');
    const cached = { UUID: 'uuid-light_5', displayName: 'Faretti', context: { device: { id: 'light_5', type: 'light', name: 'Faretti', description: '', status: { on: true, dimmable: false } } } };
    const applied = [];
    const registry = new AccessoryRegistry({
        api: { hap: { uuid: { generate: (id) => `uuid-${id}` } } },
        log,
        pluginName: 'p', platformName: 'P',
        accessories: new Map([[cached.UUID, cached]]),
        accessoryHandlers: new Map([[cached.UUID, {}]]),
        activeDiscoveredUUIDs: new Set(),
        createAccessoryHandler: () => ({}),
        updateAccessoryHandler: (_h, device) => applied.push(device.status.on),
    });

    const placeholder = { id: 'light_5', type: 'light', name: 'Faretti', description: '', status: { on: false, dimmable: false } };
    markStatusPlaceholder(placeholder);
    registry.addAccessory(placeholder);

    assert.deepEqual(applied, [true]);
    assert.equal(cached.context.device.status.on, true);
});
