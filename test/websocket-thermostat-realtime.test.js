const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');
const { ThermostatStatusUpdater } = require('../dist/websocket-client/thermostat-status-updater.js');
const { StatusUpdater } = require('../dist/websocket-client/status-updater.js');
const { SystemTemperatureUpdater } = require('../dist/websocket-client/system-temperature-updater.js');
const { MessageService } = require('../dist/websocket-client/message-service.js');
const { CommandService } = require('../dist/websocket-client/command-service.js');

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

function createThermostatStatusUpdater(state, updates = []) {
  return new ThermostatStatusUpdater({
    state,
    emitDeviceStatusUpdate: (device) => updates.push(device.id),
  });
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
    debugEnabled: false,
    emitDeviceDiscovered: () => undefined,
    emitDeviceStatusUpdate: (device) => updates.push(device.id),
  });
}

test('STATUS_TEMPERATURES maps MAN/WIN and MAN/SUM to heat/cool', () => {
  const state = createInitialWebSocketClientState();
  const updates = [];
  const updater = createThermostatStatusUpdater(state, updates);

  const heatThermostat = createThermostat('18');
  const coolThermostat = createThermostat('34');
  state.devices.set(heatThermostat.id, heatThermostat);
  state.devices.set(coolThermostat.id, coolThermostat);
  state.thermostatProgramIdByOutputId.set('18', '1');
  state.thermostatProgramIdByOutputId.set('34', '1');
  state.thermostatToDomus.set('18', '1');
  state.thermostatToDomus.set('34', '1');

  updater.updateTemperatureStatuses([{
    ID: '1',
    TEMP: '21.7',
    THERM: {
      ACT_MODEL: 'MAN',
      ACT_SEA: 'WIN',
      OUT_STATUS: 'ON',
      TEMP_THR: { T: 'M', VAL: '21.3' },
    },
  }]);

  assert.equal(heatThermostat.status.mode, 'heat');
  assert.equal(heatThermostat.status.currentTemperature, 21.7);
  assert.equal(heatThermostat.status.targetTemperature, 21.3);
  assert.equal(heatThermostat.status.hvacOutputActive, true);
  assert.equal(coolThermostat.status.mode, 'heat');
  assert.ok(updates.includes('thermostat_18'));

  updater.updateTemperatureStatuses([{
    ID: '1',
    TEMP: '22.4',
    THERM: {
      ACT_MODEL: 'MAN',
      ACT_SEA: 'SUM',
      OUT_STATUS: 'OFF',
      TEMP_THR: { T: 'M', VAL: '24.0' },
    },
  }]);

  assert.equal(heatThermostat.status.mode, 'cool');
  assert.equal(heatThermostat.status.currentTemperature, 22.4);
  assert.equal(heatThermostat.status.targetTemperature, 24);
  assert.equal(heatThermostat.status.hvacOutputActive, false);
});

test('STATUS_TEMPERATURES maps OFF and ignores NA target values', () => {
  const state = createInitialWebSocketClientState();
  const updater = createThermostatStatusUpdater(state);
  const thermostat = createThermostat('19');
  thermostat.status.targetTemperature = 23;
  thermostat.targetTemperature = 23;
  state.devices.set(thermostat.id, thermostat);
  state.thermostatProgramIdByOutputId.set('19', '5');
  state.thermostatToDomus.set('19', '5');

  updater.updateTemperatureStatuses([{
    ID: '5',
    TEMP: '20.6',
    THERM: {
      ACT_MODEL: 'OFF',
      ACT_SEA: 'WIN',
      OUT_STATUS: 'OFF',
      TEMP_THR: { T: 'NA', VAL: 'NA' },
    },
  }]);

  assert.equal(thermostat.status.mode, 'off');
  assert.equal(thermostat.status.currentTemperature, 20.6);
  assert.equal(thermostat.status.targetTemperature, 23);
  assert.equal(thermostat.status.hvacOutputActive, false);
});

test('fresh STATUS_TEMPERATURES prevents DOMUS and STATUS_SYSTEM from overwriting thermostat current temperature', () => {
  const state = createInitialWebSocketClientState({
    enabled: true,
    manualPairs: [],
    sensorFreshnessMs: 300000,
  });
  const thermostatUpdates = [];
  const thermostatUpdater = createThermostatStatusUpdater(state, thermostatUpdates);
  const statusUpdater = createStatusUpdater(state, thermostatUpdates);
  const systemUpdater = createSystemTemperatureUpdater(state, thermostatUpdates);

  const thermostat = createThermostat('18');
  state.devices.set(thermostat.id, thermostat);
  state.thermostatProgramIdByOutputId.set('18', '1');
  state.thermostatToDomus.set('18', '1');

  thermostatUpdater.updateTemperatureStatuses([{
    ID: '1',
    TEMP: '21.7',
    THERM: {
      ACT_MODEL: 'MAN',
      ACT_SEA: 'WIN',
      OUT_STATUS: 'ON',
      TEMP_THR: { T: 'M', VAL: '21.3' },
    },
  }]);

  statusUpdater.updateSensorStatuses([{ ID: '1', DOMUS: { TEM: '23.5', HUM: '49', LHT: '80' } }]);
  systemUpdater.updateSystemTemperatures([{ ID: '1', TEMP: { IN: '19.0', OUT: 'NA' } }]);

  assert.equal(thermostat.status.currentTemperature, 21.7);
  assert.equal(thermostat.status.humidity, 49);
  assert.equal(thermostat.status.targetTemperature, 21.3);
});

test('message pipeline applies STATUS_TEMPERATURES from realtime snapshots and changes', () => {
  const state = createInitialWebSocketClientState({
    enabled: true,
    manualPairs: [],
    sensorFreshnessMs: 300000,
  });
  const updates = [];
  const statusUpdater = createStatusUpdater(state, updates);
  const thermostatUpdater = createThermostatStatusUpdater(state, updates);
  const systemTemperatureUpdater = createSystemTemperatureUpdater(state, updates);
  const messageService = new MessageService({
    state,
    callbacks: {},
    log: createLogger(),
    logLevel: 2,
    debugEnabled: false,
    statusUpdater,
    systemTemperatureUpdater,
    thermostatStatusUpdater: thermostatUpdater,
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
      OUTPUTS: [{ ID: '18', DES: 'Riscaldamento Sala', TYPE: 'THERM', STATUS: '0', ENABLED: 'YES', CAT: 'THERMO' }],
      BUS_HAS: [{ ID: '1', DES: 'Term. Sala', TYP: 'DOMUS', ENABLED: 'YES' }],
    },
  });

  messageService.handleReadResponse({
    CMD: 'READ_RES',
    ID: '1b',
    SENDER: 'x',
    RECEIVER: 'x',
    TIMESTAMP: '0',
    CRC_16: '0x0000',
    PAYLOAD_TYPE: 'PRG_THERMOSTATS',
    PAYLOAD: {
      PRG_THERMOSTATS: [{ ID: '1', DES: 'Termostato Sala', PERIPH: { TYP: 'DOMUS', PID: '1' }, HEATING_OUT: '18' }],
    },
  });

  messageService.handleRealtimeResponse({
    CMD: 'REALTIME_RES',
    ID: '2',
    SENDER: 'x',
    RECEIVER: 'x',
    TIMESTAMP: '0',
    CRC_16: '0x0000',
    PAYLOAD_TYPE: 'REGISTER_ACK',
    PAYLOAD: {
      STATUS_TEMPERATURES: [{
        ID: '1',
        TEMP: '21.4',
        THERM: {
          ACT_MODEL: 'MAN',
          ACT_SEA: 'WIN',
          OUT_STATUS: 'OFF',
          TEMP_THR: { T: 'M', VAL: '21.0' },
        },
      }],
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
        STATUS_TEMPERATURES: [{
          ID: '1',
          TEMP: '22.0',
          THERM: {
            ACT_MODEL: 'MAN',
            ACT_SEA: 'SUM',
            OUT_STATUS: 'ON',
            TEMP_THR: { T: 'M', VAL: '24.0' },
          },
        }],
      },
    },
  });

  const thermostat = state.devices.get('thermostat_18');
  assert.equal(thermostat.status.currentTemperature, 22);
  assert.equal(thermostat.status.targetTemperature, 24);
  assert.equal(thermostat.status.mode, 'cool');
  assert.equal(thermostat.status.hvacOutputActive, true);
});

test('PRG_THERMOSTATS routes thermostat output 21 to cfg id 3 and sensor 4', () => {
  const state = createInitialWebSocketClientState({
    enabled: true,
    manualPairs: [],
    sensorFreshnessMs: 300000,
  });
  const updates = [];
  const statusUpdater = createStatusUpdater(state, updates);
  const thermostatUpdater = createThermostatStatusUpdater(state, updates);
  const systemTemperatureUpdater = createSystemTemperatureUpdater(state, updates);
  const messageService = new MessageService({
    state,
    callbacks: {},
    log: createLogger(),
    logLevel: 2,
    debugEnabled: false,
    statusUpdater,
    systemTemperatureUpdater,
    thermostatStatusUpdater: thermostatUpdater,
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
      OUTPUTS: [{ ID: '21', DES: 'Riscaldamento Matrimoniale', TYPE: 'THERM', STATUS: '0', ENABLED: 'YES', CAT: 'THERMO' }],
      BUS_HAS: [{ ID: '4', DES: 'Term. Matrimoniale', TYP: 'DOMUS', ENABLED: 'YES' }],
    },
  });

  messageService.handleReadResponse({
    CMD: 'READ_RES',
    ID: '2',
    SENDER: 'x',
    RECEIVER: 'x',
    TIMESTAMP: '0',
    CRC_16: '0x0000',
    PAYLOAD_TYPE: 'PRG_THERMOSTATS',
    PAYLOAD: {
      PRG_THERMOSTATS: [{ ID: '3', DES: 'Termostato Matrimoniale', PERIPH: { TYP: 'DOMUS', PID: '4' }, HEATING_OUT: '21' }],
    },
  });

  messageService.handleReadResponse({
    CMD: 'READ_RES',
    ID: '3',
    SENDER: 'x',
    RECEIVER: 'x',
    TIMESTAMP: '0',
    CRC_16: '0x0000',
    PAYLOAD_TYPE: 'CFG_THERMOSTATS',
    PAYLOAD: {
      CFG_THERMOSTATS: [{
        ID: '3',
        ACT_MODE: 'MAN',
        ACT_SEA: 'WIN',
        WIN: { TM: '27.0' },
        SUM: { TM: '22.0' },
      }],
    },
  });

  messageService.handleRealtimeResponse({
    CMD: 'REALTIME_RES',
    ID: '4',
    SENDER: 'x',
    RECEIVER: 'x',
    TIMESTAMP: '0',
    CRC_16: '0x0000',
    PAYLOAD_TYPE: 'REGISTER_ACK',
    PAYLOAD: {
      STATUS_TEMPERATURES: [{
        ID: '3',
        TEMP: '20.9',
        THERM: {
          ACT_MODEL: 'MAN',
          ACT_SEA: 'SUM',
          OUT_STATUS: 'OFF',
          TEMP_THR: { T: 'M', VAL: '22.0' },
        },
      }],
    },
  });

  const thermostat = state.devices.get('thermostat_21');
  assert.equal(state.thermostatProgramIdByOutputId.get('21'), '3');
  assert.equal(state.thermostatToDomus.get('21'), '4');
  assert.equal(thermostat.status.targetTemperature, 22);
  assert.equal(thermostat.status.currentTemperature, 20.9);
  assert.equal(thermostat.status.mode, 'cool');
});

test('CommandService does not fall back to legacy WRITE/THERMOSTAT', async () => {
  const calls = [];
  const service = new CommandService({
    state: {
      idLogin: '3',
      ws: { readyState: 1 },
      thermostatProgramById: new Map(),
      thermostatProgramIdByOutputId: new Map([['18', '1']]),
      domusSensorIdByThermostatProgramId: new Map([['1', '1']]),
      thermostatCommandIdByOutputId: new Map([['18', '1']]),
      thermostatCfgById: new Map([['1', { ID: '1', ACT_MODE: 'MAN', ACT_SEA: 'WIN', WIN: { TM: '21.0' } }]]),
      domusThermostatConfig: { enabled: true, manualPairs: [], manualCommandPairs: [], sensorFreshnessMs: 300000 },
      thermostatToDomus: new Map([['18', '1']]),
      missingThermostatProgramWarningOutputIds: new Set(),
    },
    sender: 'sender',
    pin: '1234',
    log: createLogger(),
    logLevel: 2,
    options: {},
    commandDispatcher: { enqueueDeviceCommand: (_id, task) => task() },
    wsTransport: { send: async () => undefined },
    emitRawMessage: () => undefined,
  });

  service.sendKseniaCommand = async (...args) => {
    calls.push(args[0]);
    throw new Error('boom');
  };

  await assert.rejects(() => service.setThermostatMode('thermostat_18', 'heat'));
  assert.deepEqual(calls, ['WRITE_CFG']);
});

test('CommandService writes cfg id from PRG_THERMOSTATS instead of DOMUS sensor id', async () => {
  const writes = [];
  const service = new CommandService({
    state: {
      idLogin: '3',
      ws: { readyState: 1 },
      thermostatProgramById: new Map([['3', { ID: '3', PERIPH: { PID: '4' }, HEATING_OUT: '21' }]]),
      thermostatProgramIdByOutputId: new Map([['21', '3']]),
      domusSensorIdByThermostatProgramId: new Map([['3', '4']]),
      thermostatCommandIdByOutputId: new Map(),
      thermostatCfgById: new Map([['3', { ID: '3', ACT_MODE: 'MAN', ACT_SEA: 'WIN', WIN: { TM: '21.0' }, SUM: { TM: '22.0' } }]]),
      domusThermostatConfig: { enabled: true, manualPairs: [], manualCommandPairs: [], sensorFreshnessMs: 300000 },
      thermostatToDomus: new Map([['21', '4']]),
      missingThermostatProgramWarningOutputIds: new Set(),
    },
    sender: 'sender',
    pin: '1234',
    log: createLogger(),
    logLevel: 2,
    options: {},
    commandDispatcher: { enqueueDeviceCommand: (_id, task) => task() },
    wsTransport: { send: async () => undefined },
    emitRawMessage: () => undefined,
  });

  service.sendKseniaCommand = async (...args) => {
    writes.push({ cmd: args[0], payloadType: args[1], payload: args[2] });
  };

  await service.setThermostatTemperature('thermostat_21', 27);
  assert.equal(writes[0].cmd, 'WRITE_CFG');
  assert.equal(writes[0].payload.CFG_THERMOSTATS[0].ID, '3');
});
