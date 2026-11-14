'use strict';

// Output role, registration attempts and ACK-confirmed values for Matter
// thermostats, on the in-memory Homebridge fixture. Conformance and live
// behaviour are in matter-thermostat-real-stack.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS = '0';
process.env.KLARES4_MATTER_REGISTER_TIMEOUT_MS = '300';
process.env.KLARES4_MATTER_REGISTER_POLL_MS = '5';
process.env.KLARES4_MATTER_REGISTER_POLL_MAX_MS = '10';
process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS = '0';

const {
    deriveThermostatOutputRole, thermostatRole, isRoleInSeason, thermostatRunningState, activeSeason,
} = require('../dist/platform/matter-thermostat-role.js');
const { buildThermostatMatterState, thermostatSystemModeFor, matterSystemModeForRole } = require('../dist/platform/matter-thermostat-mapper.js');
const { nextThermostatAttempt, resetThermostatAttempts } = require('../dist/platform/matter-thermostat-attempts.js');
const { MatterThermostatEchoTracker } = require('../dist/platform/matter-thermostat-echo-tracker.js');
const { deviceToMatterAccessory } = require('../dist/platform/matter-device-mapper.js');
const { MatterAccessoryRegistry } = require('../dist/platform/matter-accessory-registry.js');
const { markStatusObserved } = require('../dist/device-observation.js');
const { makeHbMatterApi } = require('./fixtures/hb-matter-api.js');
const { waitFor } = require('./fixtures/wait-for.js');
const { tmpStorage } = require('./fixtures/tmp-storage.js');

const FALLBACK_FILE = 'klares4-matter-fallback.json';

function thermostat(n, { mode = 'heat', target = 21, role, season, active, name } = {}) {
    const status = { currentTemperature: 20.5, targetTemperature: target, mode };
    if (season) status.season = season === 'summer' ? 'SUM' : 'WIN';
    if (active !== undefined) status.hvacOutputActive = active;
    const device = {
        id: `thermostat_${n}`, type: 'thermostat', name: name ?? `Termostato prova ${n}`, description: '',
        currentTemperature: 20.5, targetTemperature: target, mode, status,
    };
    if (role) status.outputRole = role;
    markStatusObserved(device);
    return device;
}

function recordingLog() {
    const lines = [];
    const at = (level) => (msg) => lines.push(`[${level}] ${msg}`);
    return { lines, log: { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') } };
}

test('deriveThermostatOutputRole: the program decides; the panel name only without program data', () => {
    const program = { HEATING_OUT: '18', COOLING_OUT: '34' };
    assert.equal(deriveThermostatOutputRole('18', program, 'Raffrescamento prova'), 'heating');
    assert.equal(deriveThermostatOutputRole('34', program, 'Riscaldamento prova'), 'cooling');
    assert.equal(deriveThermostatOutputRole('7', { HEATING_OUT: ' 7', COOLING_OUT: '7' }), 'heating-cooling');
    assert.equal(deriveThermostatOutputRole('18', { HEATING_OUT: '18', COOLING_OUT: 'NU' }), 'heating');
    assert.equal(deriveThermostatOutputRole('NU', { HEATING_OUT: 'NU' }), undefined);
    assert.equal(deriveThermostatOutputRole('5', undefined, 'Climatizzazione prova'), 'heating-cooling');
    assert.equal(deriveThermostatOutputRole('5', undefined, 'Termostato prova'), 'heating');
    assert.equal(deriveThermostatOutputRole('5', { HEATING_OUT: '6' }), undefined);
});

test('invariant 3: with status.outputRole set, a Matter or custom name does not change the endpoint', () => {
    const plain = thermostat(1, { role: 'heating' });
    const renamed = { ...plain, name: 'Cooling prova' };
    assert.equal(thermostatRole(renamed), 'heating');
    assert.deepEqual(buildThermostatMatterState(renamed), buildThermostatMatterState(plain));
});

test('TH-05: season and systemMode per role', () => {
    const cases = [
        // role, mode, season, systemMode shown, in season
        ['heating', 'heat', undefined, 4, true],
        ['heating', 'cool', undefined, 0, false],
        ['heating', 'auto', 'summer', 0, false],
        ['heating', 'auto', 'winter', 4, true],
        ['heating', 'auto', undefined, 4, true],
        ['heating', 'off', 'winter', 0, true],
        ['cooling', 'cool', undefined, 3, true],
        ['cooling', 'heat', undefined, 0, false],
        ['cooling', 'auto', 'summer', 3, true],
        ['heating-cooling', 'auto', 'summer', 1, true],
        ['heating-cooling', 'cool', undefined, 3, true],
    ];
    for (const [role, mode, season, shown, inSeason] of cases) {
        const device = thermostat(1, { role, mode, season });
        assert.equal(thermostatSystemModeFor(role, device), shown, `${role}/${mode}/${season}`);
        assert.equal(isRoleInSeason(role, device), inSeason, `${role}/${mode}/${season}`);
    }
    assert.equal(activeSeason(thermostat(1, { mode: 'off' })), undefined);
    assert.equal(matterSystemModeForRole(1, 'heating'), null);
    assert.equal(matterSystemModeForRole(4, 'cooling'), null);
    assert.equal(matterSystemModeForRole(1, 'heating-cooling'), 'auto');
});

test('TH-05: a heating output in summer gets its setpoint from the heating side only, a cooling output only cooling attributes', () => {
    const heat = buildThermostatMatterState(thermostat(1, { role: 'heating', mode: 'cool', target: 26 }));
    assert.equal(heat.base.systemMode, 0);
    assert.equal('occupiedCoolingSetpoint' in heat.base, false);
    const cool = buildThermostatMatterState(thermostat(2, { role: 'cooling', mode: 'cool', target: 26 }));
    assert.deepEqual(Object.keys(cool.base).sort(), ['localTemperature', 'occupiedCoolingSetpoint', 'systemMode']);
    assert.equal(cool.base.occupiedCoolingSetpoint, 2600);
    assert.equal(cool.schemaInvariants.controlSequenceOfOperation, 0);
    assert.equal('minHeatSetpointLimit' in cool.schemaInvariants, false);
});

test('TH-10: running state follows the output relay; unknown stays unpublished', () => {
    assert.deepEqual(thermostatRunningState('heating', thermostat(1, { active: true })), { heat: true, cool: false });
    assert.deepEqual(thermostatRunningState('cooling', thermostat(1, { active: true, mode: 'cool' })), { heat: false, cool: true });
    assert.deepEqual(thermostatRunningState('heating', thermostat(1, { active: false })), { heat: false, cool: false });
    assert.deepEqual(thermostatRunningState('heating-cooling', thermostat(1, { active: true, mode: 'auto', season: 'summer' })), { heat: false, cool: true });
    assert.equal(thermostatRunningState('heating-cooling', thermostat(1, { active: true, mode: 'auto' })), undefined);
    assert.equal(thermostatRunningState('heating', thermostat(1)), undefined);

    const unknown = buildThermostatMatterState(thermostat(1, { role: 'heating' }));
    assert.equal('thermostatRunningState' in unknown.base, false, 'not pushed when unknown');
    assert.deepEqual(unknown.schemaInvariants.thermostatRunningState, { heat: false, cool: false }, 'declared at registration');
    const known = buildThermostatMatterState(thermostat(1, { role: 'heating', active: true }));
    assert.deepEqual(known.base.thermostatRunningState, { heat: true, cool: false });
    assert.equal('thermostatRunningState' in known.schemaInvariants, false);
});

test('TH-01: the second attempt is the 2.2.0 payload, its updates keep that shape, and there is no third', (t) => {
    const hb = makeHbMatterApi();
    const device = thermostat(41, { role: 'heating' });
    t.after(() => resetThermostatAttempts(device.id));
    const first = deviceToMatterAccessory(device, { api: hb.api, log: recordingLog().log, getWsClient: () => undefined });
    assert.equal('presetTypes' in first.clusters.thermostat, false);

    const second = nextThermostatAttempt(first);
    assert.equal(second.UUID, first.UUID);
    assert.equal(second.handlers, first.handlers);
    for (const key of ['presetTypes', 'numberOfPresets', 'occupiedCoolingSetpoint', 'unoccupiedHeatingSetpoint', 'minSetpointDeadBand']) {
        assert.ok(key in second.clusters.thermostat, key);
    }
    assert.ok('unoccupiedHeatingSetpoint' in buildThermostatMatterState(device).base, 'state updates follow the legacy shape');
    assert.equal(nextThermostatAttempt(second), undefined);

    resetThermostatAttempts(device.id);
    assert.equal('unoccupiedHeatingSetpoint' in buildThermostatMatterState(device).base, false);
    assert.equal(nextThermostatAttempt({ UUID: 'light_1', context: { device: { id: 'light_1', type: 'light' } }, clusters: {} }), undefined);
});

test('TH-01: on a runtime that only accepts the preset payload, the registry ends on a native Thermostat', async (t) => {
    const refusesConformant = (a) => a.clusters?.thermostat !== undefined && !a.clusters.thermostat.presetTypes;
    const hb = makeHbMatterApi({ failRegistration: refusesConformant });
    const device = thermostat(42, { role: 'heating' });
    t.after(() => resetThermostatAttempts(device.id));
    const { registry, lines, storagePath } = await registryWith(t, device, { hb });
    await waitFor(() => hb.endpoints.get('thermostat_42')?.clusters?.thermostat !== undefined, 5000);
    await waitFor(() => registry.getStatus('thermostat_42') === 'registered', 5000);
    const endpoint = hb.endpoints.get('thermostat_42');
    assert.equal(endpoint.deviceType.name, 'Thermostat');
    assert.ok(endpoint.clusters.thermostat.presetTypes, 'the second (2.2.0) payload is the one live');
    assert.ok(lines.some((l) => /trying the payload of earlier versions/.test(l)));
    assert.equal(lines.some((l) => /falling back to TemperatureSensor before/.test(l)), false);
    const record = JSON.parse(fs.readFileSync(path.join(storagePath, FALLBACK_FILE), 'utf8')).thermostats[0];
    assert.equal(record.mode, 'native', 'no fallback persisted');
    assert.equal(record.nativeShape, 'legacy', 'the payload that worked is remembered');
    // State updates keep the attribute set of the live payload.
    const next = { ...device, status: { ...device.status, targetTemperature: 22 } };
    markStatusObserved(next);
    await registry.updateAccessoryState(next);
    await waitFor(() => hb.updates.some((u) => u.uuid === 'thermostat_42' && u.attributes.occupiedHeatingSetpoint === 2200));
    const pushed = hb.updates.filter((u) => u.uuid === 'thermostat_42' && u.cluster === 'thermostat').at(-1);
    assert.ok('unoccupiedHeatingSetpoint' in pushed.attributes);
    assert.equal(hb.rejectedUpdates.length, 0);
});

test('TH-01: when neither payload is accepted, the TemperatureSensor fallback comes back and the attempts restart from the first', async (t) => {
    const hb = makeHbMatterApi({ failRegistration: (a) => a.clusters?.thermostat !== undefined });
    const attempts = [];
    const register = hb.api.matter.registerPlatformAccessories;
    hb.api.matter.registerPlatformAccessories = async (plugin, platform, list) => {
        for (const a of list) attempts.push(a.clusters.thermostat ? (a.clusters.thermostat.presetTypes ? 'legacy' : 'conformant') : 'sensor');
        return register(plugin, platform, list);
    };
    const device = thermostat(46, { role: 'heating' });
    const { registry } = await registryWith(t, device, { hb });
    await waitFor(() => hb.endpoints.get('thermostat_46')?.deviceType.name === 'TemperatureSensor', 5000);
    await waitFor(() => registry.getStatus('thermostat_46') === 'registered', 5000);
    assert.deepEqual(attempts, ['conformant', 'legacy', 'sensor']);
    assert.equal('presetTypes' in buildThermostatMatterState(device).schemaInvariants, false, 'shape reset after the fallback');
});

test('TH-08: an acknowledged value stands until the realtime reports it, or its TTL ends', () => {
    let now = 1000;
    const tracker = new MatterThermostatEchoTracker(10_000, () => now, 5_000);
    assert.equal(tracker.effectiveTarget('t', 21), 21);
    tracker.recordConfirmed('t', 'target', 26);
    assert.equal(tracker.effectiveTarget('t', 21), 26, 'realtime still old');
    assert.equal(tracker.effectiveTarget('t', 26), 26, 'realtime caught up');
    assert.equal(tracker.effectiveTarget('t', 21), 21, 'entry ended with the confirmation');

    tracker.recordConfirmed('t', 'mode', 'off');
    assert.equal(tracker.effectiveMode('t', 'heat'), 'off');
    now += 5_001;
    assert.equal(tracker.effectiveMode('t', 'heat'), 'heat', 'TTL ended');
    tracker.recordConfirmed('t', 'target', 22);
    tracker.clear('t');
    assert.equal(tracker.effectiveTarget('t', 21), 21);
});

async function registryWith(t, device, { hb = makeHbMatterApi(), storagePath = tmpStorage(t, 'klares4-thermo-role-'), ws, recoveryRequests } = {}) {
    const { lines, log } = recordingLog();
    const registry = new MatterAccessoryRegistry({ api: hb.api, log, getWsClient: () => ws, storagePath, recoveryRequests });
    registry.startDiscoveryCycle();
    await registry.addOrUpdateAccessory(device);
    await waitFor(() => ['registered', 'failed'].includes(registry.getStatus(device.id)), 5000);
    return { hb, registry, lines, storagePath };
}

test('TH-05: Off on a heating output out of season is not forwarded (it would stop the cooling)', async (t) => {
    const calls = [];
    const ws = { async setThermostatMode(id, mode) { calls.push(mode); }, async setThermostatTemperature() { calls.push('temp'); } };
    const { hb, lines } = await registryWith(t, thermostat(43, { role: 'heating', mode: 'auto', season: 'summer' }), { ws });
    assert.equal(hb.endpoints.get('thermostat_43').clusters.thermostat.systemMode, 0);
    await hb.invoke('thermostat_43', 'thermostat', 'systemModeChange', { systemMode: 0 });
    await hb.invoke('thermostat_43', 'thermostat', 'setpointRaiseLower', { mode: 0, amount: 10 });
    assert.deepEqual(calls, []);
    assert.ok(lines.some((l) => /setpointRaiseLower not forwarded/.test(l)));
});

test('TH-15: an unsupported systemMode that matter.js lets through is reported and the known mode re-published', async (t) => {
    const ws = { async setThermostatMode() { throw new Error('must not be called'); } };
    const { hb, lines } = await registryWith(t, thermostat(44, { role: 'heating' }), { ws });
    const before = hb.updates.length;
    await hb.invoke('thermostat_44', 'thermostat', 'systemModeChange', { systemMode: 1 });
    assert.ok(lines.some((l) => l.startsWith('[warn]') && /systemMode 1 is not supported by this heating output/.test(l)));
    await waitFor(() => hb.updates.slice(before).some((u) => u.uuid === 'thermostat_44' && u.attributes.systemMode === 4));
});

test('TH-01: a failed automatic recovery returns to TemperatureSensor and is not repeated; matterRecoveryRequests still works', async (t) => {
    const storagePath = tmpStorage(t, 'klares4-thermo-role-');
    fs.writeFileSync(path.join(storagePath, FALLBACK_FILE), JSON.stringify({ thermostatAsTemperatureSensor: ['thermostat_45'] }));
    const device = thermostat(45, { role: 'heating' });
    const refusing = makeHbMatterApi({ failRegistration: (a) => 'thermostat' in (a.clusters ?? {}) });

    const boot1 = await registryWith(t, device, { hb: refusing, storagePath });
    await waitFor(() => refusing.endpoints.get('thermostat_45')?.deviceType.name === 'TemperatureSensor');
    assert.ok(boot1.lines.some((l) => /trying the native Thermostat once/.test(l)));
    await waitFor(() => boot1.registry.getStatus('thermostat_45') === 'registered');
    const store = () => JSON.parse(fs.readFileSync(path.join(storagePath, FALLBACK_FILE), 'utf8')).thermostats[0];
    assert.equal(store().mode, 'fallback');
    assert.equal(store().attempts, 1);

    const accepting = makeHbMatterApi();
    const boot2 = await registryWith(t, device, { hb: accepting, storagePath });
    assert.equal(accepting.endpoints.get('thermostat_45').deviceType.name, 'TemperatureSensor', 'no second automatic attempt');
    assert.equal(boot2.lines.some((l) => /trying the native Thermostat once/.test(l)), false);

    const boot3 = await registryWith(t, device, { hb: makeHbMatterApi(), storagePath, recoveryRequests: { thermostat_45: 1 } });
    assert.equal(boot3.hb.endpoints.get('thermostat_45').deviceType.name, 'Thermostat');
    assert.equal(store().mode, 'native');
});

/** Payload kind of every Thermostat register call the plugin makes. */
function recordAttempts(hb, uuid) {
    const attempts = [];
    const register = hb.api.matter.registerPlatformAccessories;
    hb.api.matter.registerPlatformAccessories = async (plugin, platform, list) => {
        for (const a of list) {
            if (a.UUID === uuid) attempts.push(a.clusters.thermostat ? (a.clusters.thermostat.presetTypes ? 'legacy' : 'conformant') : 'sensor');
        }
        return register(plugin, platform, list);
    };
    return attempts;
}

test('TH-01: the payload that worked is where the next start begins, and the plugin follows a runtime that changes', async (t) => {
    const storagePath = tmpStorage(t, 'klares4-thermo-role-');
    const device = thermostat(47, { role: 'heating' });
    t.after(() => resetThermostatAttempts(device.id));
    const onlyLegacy = (a) => a.clusters?.thermostat !== undefined && !a.clusters.thermostat.presetTypes;
    const onlyConformant = (a) => a.clusters?.thermostat !== undefined && !!a.clusters.thermostat.presetTypes;
    const store = () => JSON.parse(fs.readFileSync(path.join(storagePath, FALLBACK_FILE), 'utf8')).thermostats[0];

    // Each boot: a new registry and a new Homebridge (restored from the previous one's cache).
    const boot = async (failRegistration, restored = []) => {
        const hb = makeHbMatterApi({ failRegistration, restored });
        const attempts = recordAttempts(hb, device.id);
        const { registry } = await registryWith(t, device, { hb, storagePath });
        await waitFor(() => registry.getStatus(device.id) === 'registered', 5000);
        return { hb, attempts };
    };

    const boot1 = await boot(onlyLegacy);
    assert.deepEqual(boot1.attempts, ['conformant', 'legacy']);
    assert.equal(store().nativeShape, 'legacy');

    const boot2 = await boot(onlyLegacy, boot1.hb.cacheSnapshot());
    assert.deepEqual(boot2.attempts, ['legacy'], 'no refused attempt at the second start');
    assert.equal(boot2.hb.endpoints.get(device.id).deviceType.name, 'Thermostat');

    // Homebridge updated: now only the conformant payload is accepted.
    // (the new runtime could not restore the cached endpoint built with the old payload)
    const boot3 = await boot(onlyConformant);
    assert.deepEqual(boot3.attempts, ['legacy', 'conformant']);
    assert.equal(boot3.hb.endpoints.get(device.id).deviceType.name, 'Thermostat');
    assert.equal(store().nativeShape, 'conformant');
    assert.equal(store().mode, 'native');

    const boot4 = await boot(onlyConformant, boot3.hb.cacheSnapshot());
    assert.deepEqual(boot4.attempts, ['conformant']);
});

test('TH-01: a remembered payload of another revision is not trusted', (t) => {
    const storagePath = tmpStorage(t, 'klares4-thermo-role-');
    fs.writeFileSync(path.join(storagePath, FALLBACK_FILE), JSON.stringify({ version: 2, thermostats: [
        { deviceId: 'thermostat_48', mode: 'native', reason: 'recovered', attempts: 0, nativeShape: 'legacy', nativeShapeRevision: 1, pluginVersion: '2.3.0' },
    ] }));
    const { MatterFallbackStore } = require('../dist/platform/matter-fallback-store.js');
    const store = new MatterFallbackStore(storagePath, recordingLog().log);
    assert.equal(store.rememberedShape('thermostat_48'), undefined);
});

test('TH-01: a 2.2.0 fallback file (no version) on a runtime that takes only the second payload ends native and is remembered', async (t) => {
    const storagePath = tmpStorage(t, 'klares4-thermo-role-');
    fs.writeFileSync(path.join(storagePath, FALLBACK_FILE), JSON.stringify({ thermostatAsTemperatureSensor: ['thermostat_49'] }));
    const device = thermostat(49, { role: 'heating' });
    t.after(() => resetThermostatAttempts(device.id));
    const hb = makeHbMatterApi({ failRegistration: (a) => a.clusters?.thermostat !== undefined && !a.clusters.thermostat.presetTypes });
    const attempts = recordAttempts(hb, device.id);
    const { registry, lines } = await registryWith(t, device, { hb, storagePath });
    await waitFor(() => registry.getStatus(device.id) === 'registered' && hb.endpoints.get(device.id)?.clusters?.thermostat, 5000);
    assert.ok(lines.some((l) => /trying the native Thermostat once/.test(l)));
    assert.deepEqual(attempts, ['conformant', 'legacy']);
    const record = JSON.parse(fs.readFileSync(path.join(storagePath, FALLBACK_FILE), 'utf8')).thermostats[0];
    assert.deepEqual([record.mode, record.nativeShape, record.attempts], ['native', 'legacy', 1]);
    assert.ok(fs.existsSync(path.join(storagePath, `${FALLBACK_FILE}.v1.bak`)));
});
