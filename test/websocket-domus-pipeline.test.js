const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');
const { StatusUpdater } = require('../dist/websocket-client/status-updater.js');
const { SystemTemperatureUpdater } = require('../dist/websocket-client/system-temperature-updater.js');
const { MessageService } = require('../dist/websocket-client/message-service.js');

function createLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
}

function createThermostat(id) {
  return {
    id: `thermostat_${id}`,
    type: 'thermostat',
    name: `Thermostat ${id}`,
    description: `Thermostat ${id}`,
    status: {
      currentTemperature: 20,
      targetTemperature: 21,
      mode: 'off',
    },
    currentTemperature: 20,
    targetTemperature: 21,
    mode: 'off',
  };
}

function createStatusUpdater(state, updates = []) {
  return new StatusUpdater({
    state,
    log: createLogger(),
    logLevel: 2,
    debugEnabled: false,
    emitDeviceStatusUpdate: (device) => updates.push(device.id),
  });
}

function createSystemTemperatureUpdater(state, updates = []) {
  return new SystemTemperatureUpdater({
    state,
    log: createLogger(),
    logLevel: 2,
    debugEnabled: true,
    emitDeviceDiscovered: () => undefined,
    emitDeviceStatusUpdate: (device) => updates.push(device.id),
  });
}

test('STATUS_BUS_HA_SENSORS updates mapped thermostat and environmental sensors', () => {
  const state = createInitialWebSocketClientState({
    enabled: true,
    manualPairs: [],
    sensorFreshnessMs: 300000,
  });
  const updates = [];
  const updater = createStatusUpdater(state, updates);

  const thermostat = createThermostat('18');
  state.devices.set(thermostat.id, thermostat);
  state.thermostatToDomus.set('18', '1');

  state.devices.set('sensor_temp_1', {
    id: 'sensor_temp_1',
    type: 'sensor',
    name: 'Temp',
    description: 'Temp',
    status: { sensorType: 'temperature', value: 0, unit: 'C' },
  });
  state.devices.set('sensor_hum_1', {
    id: 'sensor_hum_1',
    type: 'sensor',
    name: 'Hum',
    description: 'Hum',
    status: { sensorType: 'humidity', value: 0, unit: '%' },
  });
  state.devices.set('sensor_light_1', {
    id: 'sensor_light_1',
    type: 'sensor',
    name: 'Lux',
    description: 'Lux',
    status: { sensorType: 'light', value: 0, unit: 'lux' },
  });

  updater.updateSensorStatuses([{ ID: '1', DOMUS: { TEM: '22.4', HUM: '51', LHT: '120' } }]);

  assert.equal(thermostat.status.currentTemperature, 22.4);
  assert.equal(thermostat.status.humidity, 51);
  assert.equal(state.devices.get('sensor_temp_1').status.value, 22.4);
  assert.equal(state.devices.get('sensor_hum_1').status.value, 51);
  assert.equal(state.devices.get('sensor_light_1').status.value, 120);
  assert.equal(state.domusLatest.get('1').temp, 22.4);
  assert.equal(state.domusLatest.get('1').hum, 51);
  assert.ok(updates.includes('thermostat_18'));
});

test('STATUS_SYSTEM does not overwrite thermostat when mapped DOMUS sensor is fresh', () => {
  const state = createInitialWebSocketClientState({
    enabled: true,
    manualPairs: [],
    sensorFreshnessMs: 300000,
  });
  const updater = createSystemTemperatureUpdater(state);

  const thermostat = createThermostat('18');
  thermostat.status.currentTemperature = 22;
  thermostat.currentTemperature = 22;
  state.devices.set(thermostat.id, thermostat);
  state.thermostatToDomus.set('18', '1');
  state.domusLatest.set('1', { temp: 22, hum: 50, ts: Date.now() });

  updater.updateSystemTemperatures([{ ID: '1', TEMP: { IN: '19.0', OUT: 'NA' } }]);

  assert.equal(thermostat.status.currentTemperature, 22);
});

test('STATUS_SYSTEM applies fallback when mapping is missing or stale', () => {
  const state = createInitialWebSocketClientState({
    enabled: true,
    manualPairs: [],
    sensorFreshnessMs: 300000,
  });
  const updater = createSystemTemperatureUpdater(state);

  const mappedThermostat = createThermostat('18');
  mappedThermostat.status.currentTemperature = 23;
  mappedThermostat.currentTemperature = 23;
  const unmappedThermostat = createThermostat('19');
  unmappedThermostat.status.currentTemperature = 24;
  unmappedThermostat.currentTemperature = 24;
  state.devices.set(mappedThermostat.id, mappedThermostat);
  state.devices.set(unmappedThermostat.id, unmappedThermostat);

  state.thermostatToDomus.set('18', '1');
  state.domusLatest.set('1', { temp: 23, hum: 50, ts: Date.now() - 600000 });

  updater.updateSystemTemperatures([{ ID: '1', TEMP: { IN: '19.0', OUT: 'NA' } }]);

  assert.equal(mappedThermostat.status.currentTemperature, 19);
  assert.equal(unmappedThermostat.status.currentTemperature, 19);
});

test('integration sequence MULTI_TYPES -> STATUS_BUS_HA_SENSORS -> STATUS_SYSTEM preserves DOMUS value', () => {
  const state = createInitialWebSocketClientState({
    enabled: true,
    manualPairs: [],
    sensorFreshnessMs: 300000,
  });

  const statusUpdater = createStatusUpdater(state);
  const systemTemperatureUpdater = createSystemTemperatureUpdater(state);
  const messageService = new MessageService({
    state,
    callbacks: {},
    log: createLogger(),
    logLevel: 2,
    debugEnabled: false,
    statusUpdater,
    systemTemperatureUpdater,
    commandService: { requestSystemData: async () => undefined },
    routeMessage: () => undefined,
    emitRawMessage: () => undefined,
    onLoginCompleted: () => undefined,
  });

  messageService.handleReadResponse({
    CMD: 'READ_RES',
    ID: '1',
    SENDER: 'x',
    RECEIVER: 'x',
    TIMESTAMP: '0',
    CRC_16: '0x0000',
    PAYLOAD_TYPE: 'MULTI_TYPES',
    PAYLOAD: {
      OUTPUTS: [
        { ID: '18', DES: 'Riscaldamento Sala', TYPE: 'THERM', STATUS: '0', ENABLED: 'YES', CAT: 'THERMO' },
        { ID: '34', DES: 'Raffrescamento Sala', TYPE: 'THERM', STATUS: '0', ENABLED: 'YES', CAT: 'THERMO' },
      ],
      BUS_HAS: [{ ID: '1', DES: 'Term. Sala', TYPE: 'DOMUS', ENABLED: 'YES' }],
    },
  });

  assert.equal(state.thermostatToDomus.get('18'), '1');
  assert.equal(state.thermostatToDomus.get('34'), '1');

  messageService.handleStatusUpdate({
    CMD: 'REALTIME',
    ID: '2',
    SENDER: 'x',
    RECEIVER: 'x',
    TIMESTAMP: '0',
    CRC_16: '0x0000',
    PAYLOAD_TYPE: 'CHANGES',
    PAYLOAD: {
      panel: {
        STATUS_BUS_HA_SENSORS: [{ ID: '1', DOMUS: { TEM: '23.0', HUM: '48', LHT: '100' } }],
      },
    },
  });

  messageService.handleStatusUpdate({
    CMD: 'REALTIME',
    ID: '3',
    SENDER: 'x',
    RECEIVER: 'x',
    TIMESTAMP: '0',
    CRC_16: '0x0000',
    PAYLOAD_TYPE: 'CHANGES',
    PAYLOAD: {
      panel: {
        STATUS_SYSTEM: [{ ID: '1', TEMP: { IN: '18.0', OUT: 'NA' } }],
      },
    },
  });

  const thermostat18 = state.devices.get('thermostat_18');
  const thermostat34 = state.devices.get('thermostat_34');
  assert.equal(thermostat18.status.currentTemperature, 23);
  assert.equal(thermostat34.status.currentTemperature, 23);
});
