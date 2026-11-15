const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');

const { Lares4Platform } = require('../dist/platform/index.js');
const { markStatusPlaceholder, markStatusObserved } = require('../dist/device-observation.js');
const { fakeApi, PlatformAccessory } = require('./fixtures/platform-session-harness.js');
const { recordingLog } = require('./fixtures/lares4-mock-panel.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const CONFIG = { platform: 'Lares4Complete', ip: '127.0.0.1', pin: '1', https: false };
const uuidOf = (id) => hap.uuid.generate(id);

function boot(t) {
    const platform = new Lares4Platform(recordingLog(), CONFIG, fakeApi(tmpStorage(t, 'klares4-observed-')));
    return platform;
}

/** What Homebridge writes to its cache and hands back to `configureAccessory` at the next start. */
function restart(t, previous, id) {
    const accessory = previous.accessories.get(uuidOf(id));
    const next = boot(t);
    const cached = new PlatformAccessory(accessory.displayName, accessory.UUID);
    cached.context = JSON.parse(JSON.stringify(accessory.context));
    next.configureAccessory(cached);
    return next;
}

const sensor = (value, placeholder) => {
    const device = { id: 'sensor_temp_3', type: 'sensor', name: 'Probe', description: '', status: { sensorType: 'temperature', value, unit: 'C' } };
    if (placeholder) markStatusPlaceholder(device);
    return device;
};
const cover = (position, placeholder) => {
    const device = { id: 'cover_5', type: 'cover', name: 'Shutter', description: '', status: { position, targetPosition: position, state: 'stopped' } };
    if (placeholder) markStatusPlaceholder(device);
    return device;
};

async function readTemperature(platform) {
    try {
        return await platform.accessoryHandlers.get(uuidOf('sensor_temp_3')).getCurrentTemperature();
    } catch (error) {
        return `error ${error.hapStatus}`;
    }
}

const NO_RESPONSE = `error ${hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE}`;

test('PLAT-R1: a sensor the panel never reported stays "no response" across restarts', async (t) => {
    const boot1 = boot(t);
    boot1.addAccessory(sensor(0, true));
    assert.equal(await readTemperature(boot1), NO_RESPONSE);

    const boot2 = restart(t, boot1, 'sensor_temp_3');
    assert.equal(await readTemperature(boot2), NO_RESPONSE, 'restored from the cache, before discovery');
    boot2.addAccessory(sensor(0, true));
    assert.equal(await readTemperature(boot2), NO_RESPONSE, 'after the discovery placeholder');

    const boot3 = restart(t, boot2, 'sensor_temp_3');
    boot3.addAccessory(sensor(0, true));
    assert.equal(await readTemperature(boot3), NO_RESPONSE, 'and the next one');
});

test('PLAT-R1: a cache written by 2.2.0 (placeholder, no marker) is not a reading', async (t) => {
    const previous = boot(t);
    previous.addAccessory(sensor(0, true));
    const legacy = previous.accessories.get(uuidOf('sensor_temp_3'));
    delete legacy.context.panelReported; // what 2.2.0 wrote: the device snapshot only
    const next = restart(t, previous, 'sensor_temp_3');
    assert.equal(await readTemperature(next), NO_RESPONSE);
});

test('PLAT-R1: a reading the panel reported survives the restart, before and after discovery', async (t) => {
    const boot1 = boot(t);
    boot1.addAccessory(sensor(0, true));
    const reported = sensor(21.5, false);
    markStatusObserved(reported); // the client does this for every real status report
    boot1.updateAccessory(reported);
    assert.equal(await readTemperature(boot1), 21.5);

    const boot2 = restart(t, boot1, 'sensor_temp_3');
    assert.equal(await readTemperature(boot2), 21.5, 'restored value is served at once');
    boot2.addAccessory(sensor(0, true));
    assert.equal(await readTemperature(boot2), 21.5, 'the discovery placeholder does not overwrite it');

    // It is replaced as soon as the panel reports again.
    const fresh = sensor(19, false);
    markStatusObserved(fresh);
    boot2.updateAccessory(fresh);
    assert.equal(await readTemperature(boot2), 19);
});

test('PLAT-R1: states without placeholders are kept from any cache, with or without the marker', async (t) => {
    const previous = boot(t);
    const light = { id: 'light_1', type: 'light', name: 'Lamp', description: '', status: { on: true, dimmable: false } };
    const zone = { id: 'zone_2', type: 'zone', name: 'Window', description: '', status: { armed: false, bypassed: false, fault: false, open: true, tampered: false } };
    previous.addAccessory(light);
    previous.addAccessory(zone);
    for (const device of [light, zone]) {
        const next = restart(t, previous, device.id);
        const handler = next.accessoryHandlers.get(uuidOf(device.id));
        assert.deepEqual(handler.device.status, device.status);
        if (device.type === 'light') assert.equal(await handler.getOn(), true);
    }
});

test('PLAT-R1: a cover position the panel reported is trusted after a restart, one never reported is not', async (t) => {
    const moves = [];
    const makeWs = () => ({ moveCover: async (id, position) => { moves.push(position); } });

    const boot1 = boot(t);
    boot1.addAccessory(cover(0, true));
    const reported = cover(40, false);
    markStatusObserved(reported);
    boot1.updateAccessory(reported);

    const reportedBoot = restart(t, boot1, 'cover_5');
    reportedBoot.wsClient = makeWs();
    await reportedBoot.accessoryHandlers.get(uuidOf('cover_5')).setTargetPosition(40);
    assert.deepEqual(moves, [], 'already there, as the panel reported');

    const never = boot(t);
    never.addAccessory(cover(0, true));
    const neverBoot = restart(t, never, 'cover_5');
    neverBoot.wsClient = makeWs();
    const handler = neverBoot.accessoryHandlers.get(uuidOf('cover_5'));
    await handler.setTargetPosition(0);
    handler.dispose();
    assert.deepEqual(moves, [0], 'a placeholder position is not a reason to skip the command');
});
