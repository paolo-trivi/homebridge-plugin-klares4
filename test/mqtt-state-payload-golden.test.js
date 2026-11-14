'use strict';

// The state payload is a contract with external consumers (a Prometheus
// exporter reads these fields): the exact JSON, field order included, is
// pinned for every device type, with full and with missing status.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeviceStatePayload } = require('../dist/mqtt/state-payload-mapper.js');

const NOW = '2026-01-02T03:04:05.000Z';

function payloadJson(t, device) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  return JSON.stringify(createDeviceStatePayload(device));
}

const base = (id, type, name) => `"id":"${id}","name":"${name}","type":"${type}","timestamp":"${NOW}"`;

const cases = [
  ['light, dimmer on',
    { id: 'light_1', type: 'light', name: 'Luce Uno', description: 'x', status: { on: true, brightness: 80, dimmable: true } },
    `{${base('light_1', 'light', 'Luce Uno')},"on":true,"brightness":80,"dimmable":true}`],
  ['light, no status',
    { id: 'light_2', type: 'light', name: 'Luce Due', description: 'x' },
    `{${base('light_2', 'light', 'Luce Due')},"on":false,"brightness":0,"dimmable":false}`],
  ['cover',
    { id: 'cover_3', type: 'cover', name: 'Tapparella Tre', description: 'x', status: { position: 40, state: 'opening' } },
    `{${base('cover_3', 'cover', 'Tapparella Tre')},"position":40,"state":"opening"}`],
  ['cover, no status',
    { id: 'cover_4', type: 'cover', name: 'Tapparella Quattro', description: 'x' },
    `{${base('cover_4', 'cover', 'Tapparella Quattro')},"position":0,"state":"stopped"}`],
  ['thermostat',
    { id: 'thermostat_5', type: 'thermostat', name: 'Termostato Cinque', description: 'x', currentTemperature: 20.5, targetTemperature: 21, mode: 'heat', humidity: 45 },
    `{${base('thermostat_5', 'thermostat', 'Termostato Cinque')},"currentTemperature":20.5,"targetTemperature":21,"mode":"heat","humidity":45}`],
  ['thermostat, nothing known (humidity omitted)',
    { id: 'thermostat_6', type: 'thermostat', name: 'Termostato Sei', description: 'x' },
    `{${base('thermostat_6', 'thermostat', 'Termostato Sei')},"currentTemperature":0,"targetTemperature":20,"mode":"off"}`],
  ['sensor',
    { id: 'sensor_temp_7', type: 'sensor', name: 'Sonda Sette', description: 'x', status: { sensorType: 'temperature', value: 18.25, unit: '°C' } },
    `{${base('sensor_temp_7', 'sensor', 'Sonda Sette')},"sensorType":"temperature","value":18.25,"unit":"°C"}`],
  ['sensor, no status',
    { id: 'sensor_temp_8', type: 'sensor', name: 'Sonda Otto', description: 'x' },
    `{${base('sensor_temp_8', 'sensor', 'Sonda Otto')},"sensorType":"unknown","value":0,"unit":""}`],
  ['zone',
    { id: 'zone_9', type: 'zone', name: 'Zona Nove', description: 'x', status: { open: true, armed: true, fault: false, bypassed: true } },
    `{${base('zone_9', 'zone', 'Zona Nove')},"open":true,"armed":true,"fault":false,"bypassed":true}`],
  ['zone, no status',
    { id: 'zone_10', type: 'zone', name: 'Zona Dieci', description: 'x' },
    `{${base('zone_10', 'zone', 'Zona Dieci')},"open":false,"armed":false,"fault":false,"bypassed":false}`],
  ['scenario',
    { id: 'scenario_11', type: 'scenario', name: 'Scenario Undici', description: 'x', status: { active: true } },
    `{${base('scenario_11', 'scenario', 'Scenario Undici')},"active":true}`],
  ['gate (published with the generic shape since 2.x)',
    { id: 'gate_12', type: 'gate', name: 'Cancello Dodici', description: 'x', status: { on: true } },
    `{${base('gate_12', 'gate', 'Cancello Dodici')},"active":false}`],
];

for (const [label, device, expected] of cases) {
  test(`state payload golden value: ${label}`, (t) => {
    assert.equal(payloadJson(t, device), expected);
  });
}

test('state payload never carries fields outside the contract (no PIN, address or raw frame)', (t) => {
  const device = { id: 'light_1', type: 'light', name: 'Luce', description: 'x', pin: '123456', raw: { PIN: '1' }, status: { on: true } };
  assert.deepEqual(Object.keys(JSON.parse(payloadJson(t, device))), ['id', 'name', 'type', 'timestamp', 'on', 'brightness', 'dimmable']);
});
