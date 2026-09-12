const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  analyzeMatterVoiceCollisions,
  normalizeVoiceName,
} = require('../dist/platform/matter-voice-analyzer.js');

function device(id, type, name) {
  return { id, type, name, description: name, status: {} };
}

function entries(devices) {
  return new Map(devices.map((item) => [item.id, {
    uuid: item.id,
    name: item.name,
    base: item.name.replace(/ - Sens\.$/, ''),
    type: item.type,
  }]));
}

test('normalizer handles NFKC, accents, abbreviations and singular/plural', () => {
  assert.equal(normalizeVoiceName('  FINESTRE Cab.  ').singular, 'finestra cabina');
  assert.equal(normalizeVoiceName('Caffè').normalized, 'caffe');
});

test('analyzer separates lexical evidence from semantic risk', () => {
  const devices = [
    device('cover_1', 'cover', 'Finestra Studio'),
    device('zone_1', 'zone', 'Finestra Studio - Sens.'),
  ];
  const result = analyzeMatterVoiceCollisions(devices, entries(devices));
  const finding = result.findings[0];
  assert.ok(finding.lexicalEvidence.includes('artificial-suffix-root'));
  assert.ok(finding.riskReasons.includes('active-passive-shadow'));
});

test('analyzer detects prefix and containment', () => {
  const devices = [
    device('light_1', 'light', 'Faretti'),
    device('light_2', 'light', 'Faretti Televisione'),
    device('light_3', 'light', 'Televisione Faretti Sala'),
  ];
  const result = analyzeMatterVoiceCollisions(devices, entries(devices));
  assert.ok(result.findings.some((finding) => finding.lexicalEvidence.includes('prefix')));
  assert.ok(result.findings.some((finding) => finding.lexicalEvidence.includes('containment')));
});

test('analyzer detects global intent and room equality', () => {
  const devices = [
    device('scenario_1', 'scenario', 'Spegni Tutto'),
    device('light_1', 'light', 'Studio'),
  ];
  const result = analyzeMatterVoiceCollisions(devices, entries(devices), ['Studio']);
  assert.ok(result.findings.some((finding) => finding.riskReasons.includes('intent-collision')));
  assert.ok(result.findings.some((finding) => finding.riskReasons.includes('room-equality')));
});

test('analyzer output and hash are deterministic', () => {
  const devices = [
    device('scenario_1', 'scenario', 'Apri Cancello'),
    device('gate_1', 'gate', 'Cancello'),
  ];
  const map = entries(devices);
  const forward = analyzeMatterVoiceCollisions(devices, map);
  const reverse = analyzeMatterVoiceCollisions([...devices].reverse(), map);
  assert.deepEqual(forward, reverse);
});

test('analyzer reports distinguishing-token truncation separately', () => {
  const devices = [
    device('cover_1', 'cover', 'Finestra Bagno Matrimoniale'),
    device('zone_1', 'zone', 'Finestra Bagno Matrimoniale'),
  ];
  const map = new Map([
    ['cover_1', { uuid: 'cover_1', name: 'Finestra Bagno Matrimoniale', base: 'Finestra Bagno Matrimoniale', type: 'cover' }],
    ['zone_1', { uuid: 'zone_1', name: 'Finestra Bagno Matrimoni - Sens.', base: 'Finestra Bagno Matrimoniale', type: 'zone' }],
  ]);
  const finding = analyzeMatterVoiceCollisions(devices, map).findings[0];
  assert.ok(finding.lexicalEvidence.includes('truncation-loss'));
});

test('real 109-device fixture produces a stable, non-empty diagnostic', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'klares4-devices.json'), 'utf8'));
  const map = new Map(fixture.devices.map((item) => [item.id, {
    uuid: item.id,
    name: item.name,
    base: item.name,
    type: item.type,
  }]));
  const first = analyzeMatterVoiceCollisions(fixture.devices, map);
  const second = analyzeMatterVoiceCollisions([...fixture.devices].reverse(), map);
  assert.ok(first.findings.length > 0);
  assert.equal(first.hash, second.hash);
});
