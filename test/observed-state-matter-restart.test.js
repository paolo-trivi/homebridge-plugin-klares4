'use strict';

// PLAT-R1 on the real Homebridge Matter stack: a restart with the cache must not
// bring a discovery placeholder back as the initial state of a measurement endpoint.

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '2000';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '10';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '50';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '10';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { markStatusObserved, markStatusPlaceholder } = require('../dist/device-observation.js');
const { realMatterStackSession } = require('./fixtures/real-matter-stack.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {}, success() {} });

const sensor = (value, placeholder) => {
    const device = { id: 'sensor_temp_8', type: 'sensor', name: 'Probe 8', description: '', status: { sensorType: 'temperature', value } };
    if (placeholder) markStatusPlaceholder(device);
    return device;
};

async function registerOn(stack, storagePath, devices) {
    const registry = new MatterAccessoryRegistry({ api: stack.api, log: silentLog(), getWsClient: () => undefined, storagePath });
    for (const accessory of stack.cached()) registry.configureCachedAccessory(accessory);
    registry.startDiscoveryCycle();
    for (const device of devices) await registry.addOrUpdateAccessory(device);
    await waitFor(() => devices.every((d) => registry.getStatus(d.id) === 'registered'), 10000);
    return registry;
}

const measured = (stack) => stack.read('sensor_temp_8', 'temperatureMeasurement')?.measuredValue;

test('real stack: a sensor never reported keeps a null measuredValue across restarts', { timeout: 60000 }, async (t) => {
    const session = realMatterStackSession(t);
    const storagePath = tmpStorage(t, 'klares4-observed-matter-');

    const boot1 = await session.start();
    await registerOn(boot1, storagePath, [sensor(0, true)]);
    assert.equal(measured(boot1), null);
    await boot1.stop();

    for (let restart = 2; restart <= 3; restart += 1) {
        const boot = await session.start();
        await registerOn(boot, storagePath, [sensor(0, true)]);
        assert.equal(measured(boot), null, `boot ${restart}`);
        await boot.stop();
    }
});

test('real stack: a cache from 2.2.0 (placeholder value, no marker) does not seed the endpoint', { timeout: 60000 }, async (t) => {
    const session = realMatterStackSession(t);
    const storagePath = tmpStorage(t, 'klares4-observed-matter-');

    const boot1 = await session.start();
    await registerOn(boot1, storagePath, [sensor(0, true)]);
    await boot1.stop();

    const boot2 = await session.start();
    // What 2.2.0 had saved: the snapshot with its placeholder, and no marker.
    for (const accessory of boot2.cached()) {
        delete accessory.context.panelReported;
        accessory.context.device.status.value = 0;
    }
    await registerOn(boot2, storagePath, [sensor(0, true)]);
    assert.equal(measured(boot2), null);
});

test('real stack: a measurement the panel reported is kept across a restart', { timeout: 60000 }, async (t) => {
    const session = realMatterStackSession(t);
    const storagePath = tmpStorage(t, 'klares4-observed-matter-');

    const boot1 = await session.start();
    const registry1 = await registerOn(boot1, storagePath, [sensor(0, true)]);
    const reported = sensor(21.5, false);
    markStatusObserved(reported);
    await registry1.updateAccessoryState(reported);
    await waitFor(() => measured(boot1) === 2150, 10000);
    await boot1.stop();

    const boot2 = await session.start();
    await registerOn(boot2, storagePath, [sensor(0, true)]);
    assert.equal(measured(boot2), 2150, 'the reported value is not replaced by the discovery placeholder');
});
