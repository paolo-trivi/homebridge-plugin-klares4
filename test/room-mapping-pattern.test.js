const test = require('node:test');
const assert = require('node:assert/strict');

const { ROOM_MAPPING_DEVICE_ID_PATTERN } = require('../dist/device-id.js');
const schema = require('../config.schema.json');

test('room mapping deviceId pattern stays aligned with device-id SSoT constant', () => {
  const schemaPattern =
    schema.schema?.properties?.roomMapping?.properties?.rooms?.items?.properties?.devices?.items
      ?.properties?.deviceId?.pattern;

  assert.equal(schemaPattern, ROOM_MAPPING_DEVICE_ID_PATTERN);
});
