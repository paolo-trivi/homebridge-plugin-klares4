const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCommandTopic,
  createDeviceSlug,
  buildStateTopic,
} = require('../dist/mqtt/topic-parser.js');

test('parseCommandTopic supports direct and room command topics', () => {
  assert.deepEqual(
    parseCommandTopic('homebridge/klares4/light/light_1/set'),
    { deviceType: 'light', deviceIdentifier: 'light_1' },
  );

  assert.deepEqual(
    parseCommandTopic('homebridge/klares4/sala/light/lampada_sala/set'),
    { deviceType: 'light', deviceIdentifier: 'lampada_sala' },
  );
});

test('parseCommandTopic rejects invalid formats', () => {
  assert.equal(parseCommandTopic('homebridge/klares4/light/light_1/state'), null);
  assert.equal(parseCommandTopic('invalid/topic'), null);
});

test('createDeviceSlug normalizes spaces, accents and symbols', () => {
  assert.equal(createDeviceSlug('Luce Soggiorno'), 'luce_soggiorno');
  assert.equal(createDeviceSlug('Tapparella Çucína #1'), 'tapparella_cucina_1');
});

test('buildStateTopic preserves existing topic contract', () => {
  assert.equal(
    buildStateTopic('homebridge/klares4', null, 'light', 'luce_soggiorno'),
    'homebridge/klares4/light/luce_soggiorno/state',
  );

  assert.equal(
    buildStateTopic('homebridge/klares4', 'sala', 'light', 'luce_soggiorno'),
    'homebridge/klares4/sala/light/luce_soggiorno/state',
  );
});
