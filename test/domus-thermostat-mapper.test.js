const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDomusThermostatMapping,
  normalizeDomusSensorId,
  normalizeThermostatOutputId,
} = require('../dist/websocket-client/domus-thermostat-mapper.js');

function createThermostats() {
  return new Map([
    ['18', { id: '18', name: 'Riscaldamento Sala' }],
    ['34', { id: '34', name: 'Raffrescamento Sala' }],
    ['19', { id: '19', name: 'Riscaldamento Studio' }],
    ['20', { id: '20', name: 'Riscaldamento Bagno' }],
    ['21', { id: '21', name: 'Riscaldamento Matrimoniale' }],
    ['22', { id: '22', name: 'Riscaldamento Cameretta' }],
  ]);
}

function createDomusSensors() {
  return new Map([
    ['1', { id: '1', name: 'Term. Sala' }],
    ['2', { id: '2', name: 'Term. Cameretta' }],
    ['3', { id: '3', name: 'Term. Bagno Grande' }],
    ['4', { id: '4', name: 'Term. Matrimoniale' }],
    ['5', { id: '5', name: 'Term. Studio' }],
  ]);
}

test('auto-mapping links room names and allows heat/cool to share same DOMUS sensor', () => {
  const result = buildDomusThermostatMapping({
    thermostatOutputs: createThermostats(),
    domusSensors: createDomusSensors(),
    manualPairs: [],
  });

  assert.equal(result.mapping.get('18'), '1');
  assert.equal(result.mapping.get('34'), '1');
  assert.equal(result.mapping.get('19'), '5');
  assert.equal(result.mapping.get('20'), '3');
  assert.equal(result.mapping.get('21'), '4');
  assert.equal(result.mapping.get('22'), '2');
  assert.equal(result.unmatched.length, 0);
});

test('manual pairs always override auto-mapping', () => {
  const result = buildDomusThermostatMapping({
    thermostatOutputs: createThermostats(),
    domusSensors: createDomusSensors(),
    manualPairs: [{ thermostatOutputId: '20', domusSensorId: '5' }],
  });

  assert.equal(result.mapping.get('20'), '5');
  assert.equal(result.sources.get('20'), 'manual');
});

test('ambiguous best score leaves thermostat unmapped for fallback', () => {
  const result = buildDomusThermostatMapping({
    thermostatOutputs: new Map([['1', { id: '1', name: 'Riscaldamento Camera' }]]),
    domusSensors: new Map([
      ['10', { id: '10', name: 'Term Camera' }],
      ['11', { id: '11', name: 'Term Camera' }],
    ]),
    manualPairs: [],
  });

  assert.equal(result.mapping.has('1'), false);
  assert.deepEqual(result.unmatched, ['1']);
  assert.equal(result.sources.get('1'), 'fallback');
});

test('normalizers accept prefixed ids and trim leading zeros', () => {
  assert.equal(normalizeThermostatOutputId('thermostat_019'), '19');
  assert.equal(normalizeThermostatOutputId('00034'), '34');
  assert.equal(normalizeDomusSensorId('sensor_01'), '1');
  assert.equal(normalizeDomusSensorId('001'), '1');
});
