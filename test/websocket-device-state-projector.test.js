const test = require('node:test');
const assert = require('node:assert/strict');

const {
  determineOutputType,
  parseOutputDevice,
  OutputTypeMemory,
  parseIntegerInRange,
  parseFloatInRange,
  mapCoverPosition,
  mapCoverState,
} = require('../dist/websocket/device-state-projector.js');

test('determineOutputType preserves output classification contract', () => {
  assert.equal(determineOutputType('LIGHT'), 'light');
  assert.equal(determineOutputType('ROLL'), 'cover');
  assert.equal(determineOutputType('GATE', 'M'), 'gate');
  assert.equal(determineOutputType('GATE', 'B'), 'cover');
  assert.equal(determineOutputType('THERMOSTAT'), 'thermostat');
  assert.equal(determineOutputType('UNKNOWN'), 'light');
});

// ---------------------------------------------------------------------------
// OutputTypeMemory — stable device.id prefix across ambiguous/incomplete updates
// ---------------------------------------------------------------------------

test('OutputTypeMemory: keeps the known type when a later update has GATE category but no MOD', () => {
  const mem = new OutputTypeMemory();
  assert.equal(mem.resolve('5', 'GATE', 'M'), 'gate');
  // Incomplete follow-up: CAT still GATE, but MOD missing — ambiguous between gate/cover.
  assert.equal(mem.resolve('5', 'GATE', undefined), 'gate', 'must not flip to cover on ambiguous data');
});

test('OutputTypeMemory: keeps the known type when a later update is missing CAT entirely', () => {
  const mem = new OutputTypeMemory();
  assert.equal(mem.resolve('6', 'GATE', 'M'), 'gate');
  assert.equal(mem.resolve('6', '', undefined), 'gate', 'must not fall back to light when CAT is missing for a known id');
});

test('OutputTypeMemory: classifies a never-seen systemId normally when data is sufficient', () => {
  const mem = new OutputTypeMemory();
  assert.equal(mem.resolve('42', 'LIGHT', undefined), 'light');
  assert.equal(mem.resolve('43', 'ROLL', undefined), 'cover');
  assert.equal(mem.resolve('44', 'GATE', 'M'), 'gate');
});

test('OutputTypeMemory: unambiguous re-classification (explicit MOD) is still honoured, not frozen', () => {
  const mem = new OutputTypeMemory();
  assert.equal(mem.resolve('7', 'GATE', 'M'), 'gate');
  // A later update with an explicit, unambiguous MOD is trusted, not overridden.
  assert.equal(mem.resolve('7', 'GATE', 'B'), 'cover');
});

test('parseOutputDevice: device.id prefix stays stable when a later update has incomplete CAT/MOD for a known gate', () => {
  const first = parseOutputDevice({
    ID: 'stable-gate-5', DES: 'Cancello Box', TYPE: 'GATE', STATUS: '0', ENABLED: 'YES', CAT: 'GATE', MOD: 'M',
  });
  assert.equal(first.id, 'gate_stable-gate-5');
  assert.equal(first.type, 'gate');

  // Later, incomplete re-poll: MOD missing for the same system ID.
  const second = parseOutputDevice({
    ID: 'stable-gate-5', DES: 'Cancello Box', TYPE: 'GATE', STATUS: '0', ENABLED: 'YES', CAT: 'GATE',
  });
  assert.equal(second.id, 'gate_stable-gate-5', 'device.id prefix must remain gate_ despite the incomplete update');
  assert.equal(second.type, 'gate');
});

test('parseOutputDevice: a brand-new output with sufficient data still classifies correctly', () => {
  const device = parseOutputDevice({
    ID: 'stable-light-1', DES: 'Luce Cucina', TYPE: 'LIGHT', STATUS: '0', ENABLED: 'YES', CAT: 'LIGHT',
  });
  assert.equal(device.id, 'light_stable-light-1');
  assert.equal(device.type, 'light');
});

test('parseOutputDevice creates thermostat with aligned fields', () => {
  const thermostat = parseOutputDevice({
    ID: '7',
    DES: 'Termostato Test',
    TYPE: 'THERM',
    STATUS: '0',
    ENABLED: 'YES',
    CAT: 'THERM',
  });

  assert.equal(thermostat.type, 'thermostat');
  assert.equal(thermostat.status.currentTemperature, thermostat.currentTemperature);
  assert.equal(thermostat.status.targetTemperature, thermostat.targetTemperature);
  assert.equal(thermostat.status.mode, thermostat.mode);
});

test('numeric parsing and cover mapping clamp values safely', () => {
  assert.equal(parseIntegerInRange('101', 0, 100), 100);
  assert.equal(parseIntegerInRange('-10', 0, 100), 0);
  assert.equal(parseIntegerInRange('abc', 0, 100), undefined);

  assert.equal(parseFloatInRange('+21.4', 5, 40), 21.4);
  assert.equal(parseFloatInRange('21,5', 5, 40), 21.5);
  assert.equal(parseFloatInRange('99', 5, 40), 40);

  assert.equal(mapCoverPosition('UP', undefined), 100);
  assert.equal(mapCoverPosition('DOWN', undefined), 0);
  assert.equal(mapCoverState('STOP', '10', '10'), 'stopped');
  assert.equal(mapCoverState('STOP', '10', '90'), 'opening');
  assert.equal(mapCoverState('STOP', '90', '10'), 'closing');
});

// ---------------------------------------------------------------------------
// normalizeDeviceName — DES hygiene at parse time (2.1.4-rc.6)
// ---------------------------------------------------------------------------

const { normalizeDeviceName } = require('../dist/websocket/device-state-projector.js');
const { parseZoneData, parseScenarioData } = require('../dist/websocket-client/device-parsers.js');

test('normalizeDeviceName trims and collapses whitespace', () => {
  assert.equal(normalizeDeviceName('Balcone Sala '), 'Balcone Sala');
  assert.equal(normalizeDeviceName('  Finestra   Studio  '), 'Finestra Studio');
  assert.equal(normalizeDeviceName('Luce\tCucina'), 'Luce Cucina');
  assert.equal(normalizeDeviceName(undefined), '');
  assert.equal(normalizeDeviceName('   '), '');
});

test('parseOutputDevice: DES with trailing space is born clean (name and description)', () => {
  const cover = parseOutputDevice({ ID: '3', CAT: 'ROLL', DES: 'Balcone Sala ' });
  assert.equal(cover.id, 'cover_3', 'id must NOT change — UUIDs never derive from names');
  assert.equal(cover.name, 'Balcone Sala');
  assert.equal(cover.description, 'Balcone Sala');

  const light = parseOutputDevice({ ID: '12', CAT: 'LIGHT', DES: '  Studio ' });
  assert.equal(light.id, 'light_12');
  assert.equal(light.name, 'Studio');
});

test('parseOutputDevice: empty/whitespace-only DES falls back to the typed placeholder', () => {
  const light = parseOutputDevice({ ID: '7', CAT: 'LIGHT', DES: '   ' });
  assert.equal(light.name, 'Light 7');
  assert.equal(light.description, '');
});

test('parseZoneData / parseScenarioData: DES normalised at parse', () => {
  const zone = parseZoneData({ ID: '24', DES: ' Finestra  Matrimoniale ', STATUS: '0' });
  assert.equal(zone.id, 'zone_24');
  assert.equal(zone.name, 'Finestra Matrimoniale');
  assert.equal(zone.description, 'Finestra Matrimoniale');

  const scenario = parseScenarioData({ ID: '15', DES: 'Apri Mattina (estate) ' });
  assert.equal(scenario.name, 'Apri Mattina (estate)', 'parse only trims/collapses — display sanitisation happens per-ecosystem');
});
