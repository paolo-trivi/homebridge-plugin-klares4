'use strict';

// Platform-level lifecycle (F1): scenarios hidden by the arming policy are
// removed from HomeKit like excluded ones (PLAT-04 case C), and a panel that
// is offline since the boot marks the cache-restored Matter endpoints
// unreachable (MAT-03).

// Read when the platform builds its Matter registry (no config key for it).
process.env.KLARES4_MATTER_UNREACHABLE_GRACE_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const hap = require('@homebridge/hap-nodejs');

const { startMockPanel } = require('./fixtures/lares4-mock-panel.js');
const { createPlatform, PlatformAccessory } = require('./fixtures/platform-session-harness.js');
const { makeHbMatterApi } = require('./fixtures/hb-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');

const syncs = (log) => log.lines.filter((l) => /Initial synchronization completed/.test(l)).length;

test('PLAT-04 (case C): a cached arming scenario goes from HomeKit at the first sync, even with only arming scenarios on the panel', async (t) => {
    const panel = await startMockPanel({ data: { SCENARIOS: [
        { ID: '3', DES: 'Partial', CAT: 'PARTIAL', PIN: 'P' },
        { ID: '1', DES: 'Disarm', CAT: 'DISARM', PIN: 'P' },
    ] } });
    t.after(() => panel.close());
    const { platform, api, log } = createPlatform(t, { port: panel.port });
    const accessory = new PlatformAccessory('Partial', hap.uuid.generate('scenario_3'));
    accessory.context.device = { id: 'scenario_3', type: 'scenario', name: 'Partial', description: '', status: { active: false } };
    platform.configureAccessory(accessory);
    api.emit('didFinishLaunching');
    await waitFor(() => syncs(log) === 1);
    assert.deepEqual(api.unregistered, ['scenario_3']);
    assert.equal(platform.accessoryHandlers.has(accessory.UUID), false);
});

function closedPort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

test('MAT-03: panel offline since the boot, the endpoints restored from the Matter cache are marked unreachable', async (t) => {
    const restored = ['light_1', 'zone_2'].map((UUID) => ({
        UUID, displayName: UUID, deviceType: { name: 'OnOffLight', deviceType: 256, behaviors: { onOff: {} } }, clusters: { onOff: { onOff: false } },
    }));
    const hb = makeHbMatterApi({ restored });
    const { platform, api } = createPlatform(t, { port: await closedPort(), matter: hb.api.matter, config: { reconnectInterval: 60_000 } });
    for (const r of restored) platform.configureMatterAccessory({ ...r, deviceType: hb.api.matter.deviceTypes.OnOffLight });
    api.emit('didFinishLaunching');
    await waitFor(() => hb.endpoints.get('light_1').reachable === false && hb.endpoints.get('zone_2').reachable === false);
});
