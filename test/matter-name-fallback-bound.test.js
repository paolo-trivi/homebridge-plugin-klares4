const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// A 32-char base leaves no room for the numeric suffix, and a 2-char id makes
// every uuid tag (4..12) identical: before F34 every candidate of the last
// resort loop was the same string, already owned by another device, and the
// loop never ended. Run in a child process so a regression fails instead of
// hanging the suite.
const BASE = 'Illuminazione Corridoio Superior'; // 32 chars
const BLOCKER = `${BASE.slice(0, 27)} - x1`; // every tag and numeric candidate

function runIsolated(source) {
    const result = spawnSync(process.execPath, ['-e', source], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 10_000,
    });
    assert.equal(result.signal, null, 'name fallback did not terminate');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

test('F34: computeMatterNameMap terminates when every uuid tag and numeric candidate is taken', () => {
    const names = runIsolated(`
        const { computeMatterNameMap } = require('./dist/platform/matter-name-map.js');
        const map = computeMatterNameMap([
            { id: 'a0', name: ${JSON.stringify(BASE)} },
            { id: 'a1', name: ${JSON.stringify(BLOCKER)} },
            { id: 'x1', name: ${JSON.stringify(BASE)} },
        ]);
        process.stdout.write(JSON.stringify([...map.values()].map((e) => [e.uuid, e.name])));
    `);
    const byId = Object.fromEntries(names);
    assert.equal(byId.a0, BASE);
    assert.equal(byId.a1, BLOCKER);
    assert.notEqual(byId.x1.toLowerCase(), BLOCKER.toLowerCase());
    assert.notEqual(byId.x1.toLowerCase(), BASE.toLowerCase());
    assert.ok(byId.x1.endsWith('x1'));
    assert.ok(Array.from(byId.x1).length <= 32);
});

test('F34: MatterNameRegistry terminates when every uuid tag and numeric candidate is taken', () => {
    const name = runIsolated(`
        const { MatterNameRegistry } = require('./dist/platform/matter-name-sanitizer.js');
        const registry = new MatterNameRegistry();
        registry.resolve('a0', ${JSON.stringify(BASE)});
        registry.resolve('a1', ${JSON.stringify(BLOCKER)});
        process.stdout.write(JSON.stringify(registry.resolve('x1', ${JSON.stringify(BASE)})));
    `);
    assert.notEqual(name.toLowerCase(), BLOCKER.toLowerCase());
    assert.notEqual(name.toLowerCase(), BASE.toLowerCase());
    assert.ok(Array.from(name).length <= 32);
});
