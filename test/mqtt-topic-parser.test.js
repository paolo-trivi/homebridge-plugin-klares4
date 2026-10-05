const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCommandTopic,
  createDeviceSlug,
  buildStateTopic,
  sanitizeTopicLevel,
} = require('../dist/mqtt/topic-parser.js');

test('sanitizeTopicLevel leaves valid topic levels untouched', () => {
  assert.equal(sanitizeTopicLevel('sala'), 'sala');
  assert.equal(sanitizeTopicLevel('Sala Grande'), 'Sala Grande');
  assert.equal(sanitizeTopicLevel('Camera_1-è'), 'Camera_1-è');
});

test('sanitizeTopicLevel replaces wildcards, level separators and NUL (MQTT-3.3.2-2)', () => {
  assert.equal(sanitizeTopicLevel('Sala+Cucina'), 'Sala_Cucina');
  assert.equal(sanitizeTopicLevel('Piano/Terra'), 'Piano_Terra');
  assert.equal(sanitizeTopicLevel('Box #1'), 'Box _1');
  assert.equal(sanitizeTopicLevel('a\u0000b'), 'a_b');
});

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

test('parseCommandTopic honours a configured topicPrefix of any depth', () => {
  assert.deepEqual(
    parseCommandTopic('klares4/light/light_1/set', 'klares4'),
    { deviceType: 'light', deviceIdentifier: 'light_1' },
  );
  assert.deepEqual(
    parseCommandTopic('klares4/sala/light/lampada_sala/set', 'klares4'),
    { deviceType: 'light', deviceIdentifier: 'lampada_sala' },
  );
  assert.deepEqual(
    parseCommandTopic('home/alarm/klares4/sala/cover/tapparella/set', 'home/alarm/klares4'),
    { deviceType: 'cover', deviceIdentifier: 'tapparella' },
  );
  assert.deepEqual(
    parseCommandTopic('homebridge/klares4/light/light_1/set', 'homebridge/klares4'),
    { deviceType: 'light', deviceIdentifier: 'light_1' },
  );
  assert.equal(parseCommandTopic('other/light/light_1/set', 'klares4'), null);
  assert.equal(parseCommandTopic('klares4/light/set', 'klares4'), null);
});

test('parseCommandTopic matches the subscribed filter when the prefix has a trailing slash', () => {
  // The bridge subscribes to `${topicPrefix}/+/+/set` with the raw prefix.
  assert.deepEqual(
    parseCommandTopic('klares4//sala/light/lampada_sala/set', 'klares4/'),
    { deviceType: 'light', deviceIdentifier: 'lampada_sala' },
  );
  assert.deepEqual(
    parseCommandTopic('klares4//light/light_1/set', 'klares4/'),
    { deviceType: 'light', deviceIdentifier: 'light_1' },
  );
});
