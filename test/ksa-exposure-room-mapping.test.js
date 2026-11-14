'use strict';

// WS-01 / PLAT-05 in the KSA import: an output of an unrecognized category
// is mapped to the device ID discovery gives it once `exposeOutputs`
// re-exposes it (`light_<id>`), never to `undefined_<id>`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveKsaImportResult } = require('../dist/ksa/derive.js');

test('room mapping uses light_<id> for outputs of an unrecognized category', () => {
    const program = {
        outputs: [
            { ID: '1', DES: 'Hall light', CAT: 'LIGHT', MOD: 'B' },
            { ID: '2', DES: 'Door strike', CAT: 'GEN', MOD: 'M' },
            { ID: '3', DES: 'Sprinkler', CAT: 'IRR', MOD: 'M' },
            { ID: '4', DES: 'No category' },
            { ID: '5', DES: 'Numeric category', CAT: 7 },
            { ID: '6', DES: 'Driveway', CAT: 'GATE', MOD: 'm' },
        ],
        zones: [], scenarios: [], busHas: [], thermostats: [],
        rooms: [{ ID: '1', DES: 'Hall' }],
        maps: ['1', '2', '3', '4', '5', '6'].map((OID) => ({ ROOM: '1', OT: 'prgOutputs', OID })),
    };
    const { derivedConfig } = deriveKsaImportResult(program, undefined, Buffer.from('x'));
    const ids = derivedConfig.roomMapping.rooms.flatMap((room) => room.devices.map((device) => device.deviceId));
    assert.deepEqual(ids, ['light_1', 'light_2', 'light_3', 'light_4', 'light_5', 'gate_6']);
    assert.ok(ids.every((id) => !id.startsWith('undefined_')));
});
