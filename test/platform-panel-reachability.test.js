'use strict';

// MATTER-RC1-06: the panel counts as connected (Matter `reachable`, MQTT
// panel status) only once a sync has completed. A panel that accepts the
// login and refuses the reads never makes the cached endpoints look live.

// Read when the platform builds its Matter registry (no config key for it).
process.env.KLARES4_MATTER_UNREACHABLE_GRACE_MS = '0';
process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startMockPanel } = require('./fixtures/lares4-mock-panel.js');
const { createPlatform } = require('./fixtures/platform-session-harness.js');
const { makeHbMatterApi } = require('./fixtures/hb-matter-api.js');
const { startFakeBroker } = require('./fixtures/fake-mqtt-broker.js');
const { waitFor } = require('./fixtures/wait-for.js');

const STATUS = 'homebridge/klares4/status';
const panelStates = (broker) => broker.published(STATUS).filter((s) => s.state === 'online').map((s) => s.panel);
const synced = (log) => log.lines.some((line) => line.includes('Initial synchronization completed'));

async function boot(t, failReads) {
    const broker = await startFakeBroker(t);
    const panel = await startMockPanel({ failReads });
    t.after(() => panel.close());
    const restored = [{
        UUID: 'light_5', displayName: 'Light A', deviceType: { name: 'OnOffLight', deviceType: 256, behaviors: { onOff: {} } },
        clusters: { onOff: { onOff: false } },
    }];
    const hb = makeHbMatterApi({ restored });
    const { platform, api, log } = createPlatform(t, {
        port: panel.port, matter: hb.api.matter, config: { mqtt: { enabled: true, broker: broker.url } },
    });
    platform.configureMatterAccessory({ ...restored[0], deviceType: hb.api.matter.deviceTypes.OnOffLight });
    api.emit('didFinishLaunching');
    return { broker, panel, hb, log };
}

test('MATTER-RC1-06: login accepted but reads refused: reachable stays false and the panel stays disconnected', async (t) => {
    const { broker, panel, hb, log } = await boot(t, ['ZONES', 'MULTI_TYPES']);
    await waitFor(() => panel.logins >= 2, 10000);
    await waitFor(() => hb.endpoints.get('light_5').reachable === false);
    await hb.settle();
    assert.equal(synced(log), false);
    assert.ok(!hb.updates.some((u) => u.cluster === 'bridgedDeviceBasicInformation' && u.attributes.reachable === true));
    await waitFor(() => panelStates(broker).length > 0);
    assert.deepEqual([...new Set(panelStates(broker))], ['disconnected']);
});

test('MATTER-RC1-06: a complete sync makes the endpoints reachable and the panel connected', async (t) => {
    const { broker, hb, log } = await boot(t, []);
    await waitFor(() => synced(log));
    await waitFor(() => panelStates(broker).at(-1) === 'connected');
    await hb.settle();
    await waitFor(() => hb.endpoints.get('light_5').reachable === true);
});
