const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DebugCaptureManager } = require('../dist/debug-capture/index.js');

test('DebugCaptureManager captures raw hooks and masks PIN', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-debug-test-'));

  let rawListener;
  const fakeWsClient = {
    getAllDevices: () => [],
    addRawMessageListener: (listener) => {
      rawListener = listener;
      return () => {
        rawListener = undefined;
      };
    },
  };

  const logger = {
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };

  const manager = new DebugCaptureManager(logger, tempDir);
  manager.startCapture(fakeWsClient, 10000);

  assert.equal(typeof rawListener, 'function');

  rawListener('out', JSON.stringify({ CMD: 'LOGIN', PAYLOAD: { PIN: '123456' } }));
  rawListener('in', JSON.stringify({ CMD: 'LOGIN_RES', PAYLOAD: { RESULT: 'OK' } }));

  manager.stopCapture(fakeWsClient);

  // The debug file is written asynchronously: poll until it parses as
  // complete JSON instead of relying on a fixed sleep.
  const deadline = Date.now() + 5000;
  let content = '';
  while (Date.now() < deadline) {
    const debugFiles = fs
      .readdirSync(tempDir)
      .filter((file) => file.startsWith('klares4-debug-') && file.endsWith('.json'));
    if (debugFiles.length > 0) {
      const latest = debugFiles.sort().at(-1);
      const candidate = fs.readFileSync(path.join(tempDir, latest), 'utf8');
      try {
        JSON.parse(candidate);
        content = candidate;
        break;
      } catch {
        // Partial write — keep polling.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(content.length > 0, true, 'debug file was not written within 5s');

  assert.equal(content.includes('***MASKED***'), true);
  assert.equal(content.includes('123456'), false);
});
