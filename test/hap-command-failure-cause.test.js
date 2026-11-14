'use strict';

// A failed command keeps its error as `cause` on the HapStatusError the
// handler throws: HomeKit still sees SERVICE_COMMUNICATION_FAILURE, and the
// MQTT bridge can tell a queue/validation refusal (warn) from a failure (error).

const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');

const { LightAccessory } = require('../dist/accessories/light-accessory.js');
const { CoverAccessory } = require('../dist/accessories/cover-accessory.js');
const { GateAccessory } = require('../dist/accessories/gate-accessory.js');
const { ScenarioAccessory } = require('../dist/accessories/scenario-accessory.js');
const { CommandExecutor } = require('../dist/mqtt-bridge/command-executor.js');
const { recordingLog } = require('./fixtures/fake-mqtt.js');
const { waitFor } = require('./fixtures/wait-for.js');

const { Characteristic, Service, HAPStatus, HapStatusError } = hap;

function platformAccessory(device) {
  const accessory = new hap.Accessory(device.name, hap.uuid.generate(device.id));
  return {
    UUID: accessory.UUID,
    displayName: device.name,
    context: { device },
    getService: (type) => accessory.getService(type),
    addService: (type) => accessory.addService(type),
  };
}

const refusal = () => Object.assign(new Error('Command for light_1 not sent'), { name: 'CommandQueueRejectedError', reason: 'busy' });

function platformRejecting(error) {
  const reject = async () => { throw error; };
  const wsClient = { switchLight: reject, dimLight: reject, moveCover: reject, toggleGate: reject, triggerScenario: reject };
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  return { Service, Characteristic, api: { hap }, log, config: {}, runtimeConfig: { scenarioAutoOffDelay: 500, coverStepSize: 5 }, wsClient };
}

const cases = [
  ['light on/off', LightAccessory, { id: 'light_1', type: 'light', name: 'L', status: { on: false, dimmable: true } }, (h) => h.setOn(true)],
  ['light brightness', LightAccessory, { id: 'light_1', type: 'light', name: 'L', status: { on: false, dimmable: true } }, (h) => h.setBrightness(40)],
  ['cover', CoverAccessory, { id: 'cover_2', type: 'cover', name: 'C', status: { position: 0, state: 'stopped' } }, (h) => h.setTargetPosition(50)],
  ['gate', GateAccessory, { id: 'gate_3', type: 'gate', name: 'G', status: { on: false } }, (h) => h.setOn(true)],
  ['scenario', ScenarioAccessory, { id: 'scenario_4', type: 'scenario', name: 'S', status: { active: false } }, (h) => h.setOn(true)],
];

for (const [label, Handler, device, act] of cases) {
  test(`${label}: HomeKit gets the same HAP status, the original error is the cause`, async () => {
    const error = refusal();
    const handler = new Handler(platformRejecting(error), platformAccessory(device), device);
    await assert.rejects(act(handler), (thrown) => {
      assert.ok(thrown instanceof HapStatusError);
      assert.equal(thrown.hapStatus, HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      assert.equal(thrown.cause, error);
      return true;
    });
  });
}

test('the MQTT executor turns a refusal carried by a HAP error into a warning with its reason', async () => {
  const handler = new LightAccessory(platformRejecting(refusal()), platformAccessory({ id: 'light_1', type: 'light', name: 'L', status: { on: false } }));
  const log = recordingLog();
  const executor = new CommandExecutor({ log: log.logger, findAccessory: () => handler });
  executor.executeCommand('light', 'light_1', '{"on":true}');
  await waitFor(() => log.lines.warn.length === 1);
  assert.match(log.lines.warn[0], /still executing the previous command/);
  assert.deepEqual(log.lines.error, []);
});

test('a HAP error without a cause is a warning pointing at the accessory log', async () => {
  const handler = { device: { id: 'light_1', type: 'light' }, setOn: async () => { throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE); } };
  const log = recordingLog();
  const executor = new CommandExecutor({ log: log.logger, findAccessory: () => handler });
  executor.executeCommand('light', 'light_1', '{"on":true}');
  await waitFor(() => log.lines.warn.length === 1);
  assert.match(log.lines.warn[0], /see the accessory error above/);
});
