'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyVersion, latestRc, changedDependencyFields, planRelease } = require('../scripts/release-guard.js');

const NAME = 'homebridge-plugin-klares4';
const RC_COMMIT = 'a'.repeat(40);

function git({ rcTags = ['v2.3.0-rc.2'], lockChanged = false, rcPackage = {} } = {}) {
    return {
        commitOf: (tag) => (rcTags.includes(tag) ? RC_COMMIT : null),
        lockfileChangedSince: (commit) => {
            assert.equal(commit, RC_COMMIT);
            return lockChanged;
        },
        packageJsonAt: () => ({ dependencies: { ws: '^8.14.2' }, devDependencies: { typescript: '^7.0.2' }, ...rcPackage }),
    };
}

function plan(overrides) {
    return planRelease({
        pkg: { name: NAME, version: '2.3.0', dependencies: { ws: '^8.14.2' }, devDependencies: { typescript: '^7.0.2' } },
        ref: 'refs/tags/v2.3.0',
        publishedVersions: ['2.2.0', '2.3.0-rc.1', '2.3.0-rc.2'],
        git: git(),
        ...overrides,
    });
}

test('classifyVersion maps stable, rc and beta versions and rejects other pre-releases', () => {
    assert.deepEqual(classifyVersion('2.3.0'), { base: '2.3.0', channel: 'latest', stable: true });
    assert.deepEqual(classifyVersion('2.3.0-rc.1'), { base: '2.3.0', channel: 'rc', stable: false });
    assert.deepEqual(classifyVersion('2.0.1-beta2'), { base: '2.0.1', channel: 'beta', stable: false });
    for (const bad of ['2.3.0-alpha.1', '2.3.0-debug0', '2.3', 'v2.3.0', '2.3.0-rc', '2.3.0+build']) {
        assert.throws(() => classifyVersion(bad), /Unsupported version/, bad);
    }
});

test('latestRc picks the highest rc number of the same base version only', () => {
    const published = ['2.3.0-rc.9', '2.3.0-rc.10', '2.3.1-rc.1', '2.3.0-rc.x', '2.3.0'];
    assert.equal(latestRc(published, '2.3.0'), '2.3.0-rc.10');
    assert.equal(latestRc(published, '2.4.0'), null);
});

test('changedDependencyFields compares dependency fields regardless of key order', () => {
    const before = { dependencies: { a: '1', b: '2' }, scripts: { x: '1' } };
    assert.deepEqual(changedDependencyFields(before, { dependencies: { b: '2', a: '1' }, scripts: { x: '2' } }), []);
    assert.deepEqual(changedDependencyFields(before, { dependencies: { a: '1', b: '3' } }), ['dependencies']);
    assert.deepEqual(changedDependencyFields(before, { dependencies: before.dependencies, devDependencies: { c: '1' } }), ['devDependencies']);
});

test('a stable release with a published rc on identical dependencies goes to latest', () => {
    assert.deepEqual(plan(), { name: NAME, version: '2.3.0', tag: 'latest', rc: '2.3.0-rc.2' });
});

test('a stable release without a published rc of the same base version is refused', () => {
    assert.throws(() => plan({ publishedVersions: ['2.2.0', '2.2.0-rc.4'] }), /no published release candidate \(2\.3\.0-rc\.N\)/);
});

test('a stable release whose rc git tag is missing is refused', () => {
    assert.throws(() => plan({ git: git({ rcTags: [] }) }), /git tag v2\.3\.0-rc\.2 is missing/);
});

test('a stable release is refused when the lockfile changed after the last rc', () => {
    assert.throws(() => plan({ git: git({ lockChanged: true }) }), /differs from 2\.3\.0-rc\.2 in package-lock\.json/);
});

test('a stable release is refused when a dependency range changed after the last rc', () => {
    assert.throws(
        () => plan({ git: git({ rcPackage: { devDependencies: { typescript: '^6.0.0' } } }) }),
        /differs from 2\.3\.0-rc\.2 in package\.json devDependencies/,
    );
});

test('prerelease versions go to their own dist-tag and need no rc', () => {
    const base = { publishedVersions: ['2.2.0'] };
    assert.equal(plan({ ...base, pkg: { name: NAME, version: '2.3.0-rc.1' }, ref: 'refs/tags/v2.3.0-rc.1' }).tag, 'rc');
    assert.equal(plan({ ...base, pkg: { name: NAME, version: '2.3.0-beta.1' }, ref: 'refs/tags/v2.3.0-beta.1' }).tag, 'beta');
});

test('the git tag must match the package version', () => {
    assert.throws(() => plan({ ref: 'refs/tags/v2.3.1' }), /Tag\/version mismatch/);
});

test('an already published version is never published again', () => {
    assert.throws(() => plan({ publishedVersions: ['2.3.0', '2.3.0-rc.2'] }), /already published/);
});
