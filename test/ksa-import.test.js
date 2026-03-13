const test = require('node:test');
const assert = require('node:assert/strict');

const { parseKsaProgramFromBuffer } = require('../dist/ksa/parser.js');
const { deriveKsaImportResult } = require('../dist/ksa/derive.js');
const { createInitialWebSocketClientState } = require('../dist/websocket-client/state.js');

test('parseKsaProgramFromBuffer extracts program arrays from embedded payload', () => {
  const payload = {
    INFO: { TYPE: 'BCK' },
    DATA: {
      PRG_OUTPUTS: [{ ID: '21', DES: 'Riscaldamento Matrimoniale', CAT: 'THERMO' }],
      PRG_ZONES: [{ ID: '24', DES: 'Finestra Matrimoniale', CAT: 'PMC' }],
      PRG_SCENARIOS: [{ ID: '7', DES: 'Apri Zona Giorno' }],
      PRG_BUS_HAS: [{ ID: '4', DOMUS: { DES: 'Term. Matrimoniale' } }],
      PRG_THERMOSTATS: [{ ID: '3', DES: 'Termostato Matrimoniale', PERIPH: { PID: '4' }, HEATING_OUT: '21' }],
      PRG_ROOMS: [{ ID: '5', DES: 'Matrimoniale' }],
      PRG_MAPS: [{ ROOM: '5', OT: 'prgOutputs', OID: '21' }],
    },
    CRC_16: '0x0000',
  };
  const buffer = Buffer.concat([
    Buffer.from('KSFS\x03\x00garbage'),
    Buffer.from(JSON.stringify(payload), 'utf8'),
    Buffer.from('tail-data'),
  ]);

  const parsed = parseKsaProgramFromBuffer(buffer);
  assert.equal(parsed.outputs.length, 1);
  assert.equal(parsed.zones.length, 1);
  assert.equal(parsed.scenarios.length, 1);
  assert.equal(parsed.busHas.length, 1);
  assert.equal(parsed.thermostats.length, 1);
  assert.equal(parsed.rooms.length, 1);
  assert.equal(parsed.maps.length, 1);
});

test('deriveKsaImportResult generates expected thermostat routing', () => {
  const program = {
    outputs: [
      { ID: '20', DES: 'Riscaldamento Bagno', CAT: 'THERMO' },
      { ID: '21', DES: 'Riscaldamento Matrimoniale', CAT: 'THERMO' },
    ],
    zones: [],
    scenarios: [],
    busHas: [
      { ID: '3', DOMUS: { DES: 'Term. Bagno Grande' } },
      { ID: '4', DOMUS: { DES: 'Term. Matrimoniale' } },
    ],
    thermostats: [
      { ID: '3', DES: 'Termostato Matrimoniale', PERIPH: { PID: '4' }, HEATING_OUT: '21' },
      { ID: '4', DES: 'Termostato Bagno', PERIPH: { PID: '3' }, HEATING_OUT: '20' },
    ],
    rooms: [{ ID: '5', DES: 'Matrimoniale' }, { ID: '4', DES: 'Bagno' }],
    maps: [
      { ROOM: '5', OT: 'prgOutputs', OID: '21' },
      { ROOM: '4', OT: 'prgOutputs', OID: '20' },
    ],
  };
  const result = deriveKsaImportResult(program, '/tmp/sample.ksa', Buffer.from('payload'));

  assert.equal(result.cache.thermostatProgramIdByOutputId['21'], '3');
  assert.equal(result.cache.thermostatProgramIdByOutputId['20'], '4');
  assert.equal(result.cache.domusSensorIdByThermostatProgramId['3'], '4');
  assert.equal(result.cache.domusSensorIdByThermostatProgramId['4'], '3');

  const commandPairs = result.derivedConfig.domusThermostat.manualCommandPairs;
  const manualPairs = result.derivedConfig.domusThermostat.manualPairs;
  assert.deepEqual(commandPairs.find((item) => item.thermostatOutputId === '21'), {
    thermostatOutputId: '21',
    commandThermostatId: '3',
  });
  assert.deepEqual(manualPairs.find((item) => item.thermostatOutputId === '21'), {
    thermostatOutputId: '21',
    domusSensorId: '4',
  });
});

test('initial websocket state preloads thermostat program maps from KSA cache', () => {
  const state = createInitialWebSocketClientState(undefined, {
    sourceFileHash: 'abc',
    parsedAt: '2026-03-13T00:00:00.000Z',
    thermostatPrograms: [{ id: '3', description: 'Termostato Matrimoniale', heatingOutputId: '21', domusSensorId: '4' }],
    thermostatProgramIdByOutputId: { '21': '3' },
    domusSensorIdByThermostatProgramId: { '3': '4' },
    outputNamesById: {},
    zoneNamesById: {},
    scenarioNamesById: {},
    domusSensorNamesById: {},
    roomNameById: {},
    roomDeviceRefs: [],
  });

  assert.equal(state.thermostatProgramIdByOutputId.get('21'), '3');
  assert.equal(state.domusSensorIdByThermostatProgramId.get('3'), '4');
  assert.equal(state.thermostatProgramById.get('3').HEATING_OUT, '21');
});
