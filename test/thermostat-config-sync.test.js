const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');
const { applyThermostatConfigSnapshot } = require('../dist/websocket-client/thermostat-config-sync.js');

function createThermostat(id, name) {
  return {
    id: `thermostat_${id}`,
    type: 'thermostat',
    name,
    description: name,
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

test('applies thermostat config from PRG_THERMOSTATS program id', () => {
  const state = createInitialWebSocketClientState({
    enabled: true,
    manualPairs: [],
    manualCommandPairs: [],
    sensorFreshnessMs: 300000,
  });
  const updates = [];

  const thermostat = createThermostat('19', 'Riscaldamento Studio');
  state.devices.set(thermostat.id, thermostat);
  state.thermostatProgramById.set('5', { ID: '5', PERIPH: { PID: '5' }, HEATING_OUT: '19' });
  state.thermostatProgramIdByOutputId.set('19', '5');
  state.domusSensorIdByThermostatProgramId.set('5', '5');
  state.thermostatCfgById.set('5', {
    ID: '5',
    ACT_MODE: 'MAN',
    ACT_SEA: 'WIN',
    WIN: { TM: '24.0' },
    SUM: { TM: '22.0' },
  });

  applyThermostatConfigSnapshot({
    state,
    emitDeviceStatusUpdate: (device) => updates.push(device.id),
  });

  assert.equal(thermostat.status.mode, 'heat');
  assert.equal(thermostat.status.targetTemperature, 24);
  assert.equal(state.thermostatCommandIdByOutputId.get('19'), '5');
  assert.deepEqual(updates, ['thermostat_19']);
});

test('manual command id override has precedence in config sync', () => {
  const state = createInitialWebSocketClientState({
    enabled: true,
    manualPairs: [],
    manualCommandPairs: [{ thermostatOutputId: '21', commandThermostatId: '3' }],
    sensorFreshnessMs: 300000,
  });

  const thermostat = createThermostat('21', 'Riscaldamento Matrimoniale');
  state.devices.set(thermostat.id, thermostat);
  state.thermostatProgramById.set('3', { ID: '3', PERIPH: { PID: '4' }, HEATING_OUT: '21' });
  state.thermostatProgramIdByOutputId.set('21', '3');
  state.domusSensorIdByThermostatProgramId.set('3', '4');
  state.thermostatCfgById.set('3', {
    ID: '3',
    ACT_MODE: 'MAN',
    ACT_SEA: 'WIN',
    WIN: { TM: '20.5' },
  });
  state.thermostatCfgById.set('4', {
    ID: '4',
    ACT_MODE: 'MAN',
    ACT_SEA: 'WIN',
    WIN: { TM: '19.0' },
  });
  applyThermostatConfigSnapshot({
    state,
    emitDeviceStatusUpdate: () => undefined,
  });

  assert.equal(thermostat.status.targetTemperature, 20.5);
  assert.equal(state.thermostatCommandIdByOutputId.get('21'), '3');
});
