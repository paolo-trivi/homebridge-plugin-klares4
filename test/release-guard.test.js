'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    classifyVersion, compareVersions, latestRc, changedDependencyFields, provenanceSource,
    planRelease, makeGit, npmRegistry, main, REPOSITORY_URL, WORKFLOW_PATH,
} = require('../scripts/release-guard.js');

const NAME = 'homebridge-plugin-klares4';
const RC_COMMIT = 'a'.repeat(40);

function source(rc, overrides = {}) {
    return { repository: REPOSITORY_URL, workflowPath: WORKFLOW_PATH, ref: `refs/tags/v${rc}`, commit: RC_COMMIT, ...overrides };
}

function registry({ versions = ['2.2.0', '2.3.0-rc.1', '2.3.0-rc.2'], distTags = { latest: '2.2.0', rc: '2.3.0-rc.2' }, releases } = {}) {
    const known = releases ?? { '2.3.0-rc.2': { provenance: source('2.3.0-rc.2') } };
    return { versions, distTags, release: async (version) => known[version] ?? null };
}

function git({ rcTags = { 'v2.3.0-rc.2': RC_COMMIT }, ancestor = true, lockChanged = false, rcPackage = {} } = {}) {
    const atRc = (commit) => assert.equal(commit, RC_COMMIT);
    return {
        commitOf: (tag) => rcTags[tag] ?? null,
        isAncestor: (commit) => (atRc(commit), ancestor),
        lockfileChangedSince: (commit) => (atRc(commit), lockChanged),
        packageJsonAt: (commit) => (atRc(commit), { dependencies: { ws: '^8.14.2' }, devDependencies: { typescript: '^7.0.2' }, ...rcPackage }),
    };
}

function plan(overrides) {
    return planRelease({
        pkg: { name: NAME, version: '2.3.0', dependencies: { ws: '^8.14.2' }, devDependencies: { typescript: '^7.0.2' } },
        ref: 'refs/tags/v2.3.0',
        registry: registry(),
        git: git(),
        ...overrides,
    });
}

test('classifyVersion maps stable, rc and beta versions and rejects other pre-releases', () => {
    assert.deepEqual(classifyVersion('2.3.0'), { base: '2.3.0', channel: 'latest', stable: true });
    assert.deepEqual(classifyVersion('2.3.0-rc.1'), { base: '2.3.0', channel: 'rc', stable: false });
    assert.deepEqual(classifyVersion('2.0.1-beta.2'), { base: '2.0.1', channel: 'beta', stable: false });
    for (const bad of ['2.3.0-alpha.1', '2.3.0-debug0', '2.3', 'v2.3.0', '2.3.0-rc', '2.3.0+build', '2.3.0-rc1', '2.0.1-beta2', '2.3.0\n']) {
        assert.throws(() => classifyVersion(bad), /Unsupported version/, bad);
    }
});

test('compareVersions follows semver precedence, including the historical pre-release names', () => {
    assert.equal(compareVersions('2.3.0', '2.2.0'), 1);
    assert.equal(compareVersions('2.2.1', '2.3.0'), -1);
    assert.equal(compareVersions('2.3.0-rc.1', '2.3.0'), -1);
    assert.equal(compareVersions('2.3.0-rc.10', '2.3.0-rc.9'), 1);
    assert.equal(compareVersions('2.3.0-beta.1', '2.0.1-beta2'), 1);
    assert.equal(compareVersions('2.3.0-rc.1', '2.3.0-rc.1'), 0);
    assert.equal(compareVersions('2.3.0-rc', '2.3.0-rc.1'), -1);
    assert.equal(compareVersions('1.1.7-debug0', 'not a version'), null);
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

test('provenanceSource reads repository, workflow, ref and commit from the SLSA statement', () => {
    const statement = {
        predicate: {
            buildDefinition: {
                externalParameters: { workflow: { repository: REPOSITORY_URL, path: WORKFLOW_PATH, ref: 'refs/tags/v2.3.0-rc.2' } },
                resolvedDependencies: [{ digest: { gitCommit: RC_COMMIT } }],
            },
        },
    };
    const payload = Buffer.from(JSON.stringify(statement)).toString('base64');
    const attestations = {
        attestations: [
            { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: { dsseEnvelope: { payload: 'e30=' } } },
            { predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload } } },
        ],
    };
    assert.deepEqual(provenanceSource(attestations), source('2.3.0-rc.2'));
    assert.equal(provenanceSource(null), null);
    assert.equal(provenanceSource({ attestations: [attestations.attestations[0]] }), null);
});

test('a stable release with a published rc on identical dependencies goes to latest', async () => {
    assert.deepEqual(await plan(), { name: NAME, version: '2.3.0', tag: 'latest', rc: '2.3.0-rc.2' });
});

test('another package name is refused', async () => {
    await assert.rejects(plan({ pkg: { name: 'other', version: '2.3.0' } }), /publishes homebridge-plugin-klares4 only/);
});

test('a stable release without a published rc of the same base version is refused', async () => {
    await assert.rejects(plan({ registry: registry({ versions: ['2.2.0', '2.2.0-rc.4'] }) }), /no published release candidate \(2\.3\.0-rc\.N\)/);
});

test('a stable release is refused when the rc has no provenance, or one from elsewhere', async () => {
    const withRelease = (release) => plan({ registry: registry({ releases: { '2.3.0-rc.2': release } }) });
    await assert.rejects(withRelease({ provenance: null }), /2\.3\.0-rc\.2 has no npm provenance/);
    await assert.rejects(withRelease(null), /metadata could not be read/);
    await assert.rejects(
        withRelease({ provenance: source('2.3.0-rc.2', { repository: 'https://github.com/someone/fork' }) }),
        /repository=https:\/\/github\.com\/someone\/fork, expected/,
    );
    await assert.rejects(
        withRelease({ provenance: source('2.3.0-rc.2', { workflowPath: '.github/workflows/other.yml' }) }),
        /workflowPath=.*not built by this release workflow/,
    );
    await assert.rejects(
        withRelease({ provenance: source('2.3.0-rc.2', { ref: 'refs/heads/main' }) }),
        /ref=refs\/heads\/main, expected refs\/tags\/v2\.3\.0-rc\.2/,
    );
    await assert.rejects(withRelease({ provenance: source('2.3.0-rc.2', { commit: 'HEAD' }) }), /no valid commit/);
});

test('a stable release is refused when the rc is deprecated', async () => {
    const release = { deprecated: 'broken thermostat', provenance: source('2.3.0-rc.2') };
    await assert.rejects(plan({ registry: registry({ releases: { '2.3.0-rc.2': release } }) }), /deprecated on npm \("broken thermostat"\)/);
});

test('a stable release whose rc git tag is missing is refused', async () => {
    await assert.rejects(plan({ git: git({ rcTags: {} }) }), /git tag v2\.3\.0-rc\.2 is missing/);
});

test('a stable release is refused when the rc git tag was moved away from the published commit', async () => {
    await assert.rejects(plan({ git: git({ rcTags: { 'v2.3.0-rc.2': 'b'.repeat(40) } }) }), /the tag was moved/);
});

test('a stable release that does not descend from the rc commit is refused', async () => {
    await assert.rejects(plan({ git: git({ ancestor: false }) }), /does not descend from a{40}/);
});

test('a stable release is refused when the lockfile changed after the last rc', async () => {
    await assert.rejects(plan({ git: git({ lockChanged: true }) }), /differs from 2\.3\.0-rc\.2 in package-lock\.json/);
});

test('a stable release is refused when a dependency range changed after the last rc', async () => {
    await assert.rejects(
        plan({ git: git({ rcPackage: { devDependencies: { typescript: '^6.0.0' } } }) }),
        /differs from 2\.3\.0-rc\.2 in package\.json devDependencies/,
    );
});

test('an rc written without the dot is refused, with the format to use', () => {
    assert.throws(() => classifyVersion('2.3.0-rc1'), /with the dot before N .*2\.3\.0-rc\.1, not 2\.3\.0-rc1/);
    // The stable release looks for -rc.N only, so -rc1 must never have been publishable.
    assert.equal(latestRc(['2.3.0-rc1'], '2.3.0'), null);
});

test('prerelease versions go to their own dist-tag and need no rc', async () => {
    const reg = registry({ versions: ['2.2.0'], distTags: { latest: '2.2.0', rc: '2.2.0-rc.4', beta: '2.0.1-beta2' } });
    assert.equal((await plan({ registry: reg, pkg: { name: NAME, version: '2.3.0-rc.1' }, ref: 'refs/tags/v2.3.0-rc.1' })).tag, 'rc');
    assert.equal((await plan({ registry: reg, pkg: { name: NAME, version: '2.3.0-beta.1' }, ref: 'refs/tags/v2.3.0-beta.1' })).tag, 'beta');
});

test('a dist-tag never moves back to an older version', async () => {
    const reg = registry({ versions: ['2.2.0', '2.3.0', '2.3.0-rc.2', '2.2.1-rc.1'], distTags: { latest: '2.3.0', rc: '2.3.0-rc.2' } });
    await assert.rejects(
        plan({ registry: reg, pkg: { name: NAME, version: '2.2.1-rc.2' }, ref: 'refs/tags/v2.2.1-rc.2' }),
        /older than 2\.3\.0-rc\.2, which the dist-tag "rc" points at/,
    );
    await assert.rejects(
        plan({ registry: { ...reg, distTags: { latest: '2.3.0' } }, pkg: { name: NAME, version: '2.2.1' }, ref: 'refs/tags/v2.2.1' }),
        /older than 2\.3\.0, which the dist-tag "latest" points at/,
    );
});

test('a pre-release of a version that is already stable is refused', async () => {
    const reg = registry({ versions: ['2.3.0', '2.3.0-rc.2'], distTags: { latest: '2.3.0' } });
    await assert.rejects(plan({ registry: reg, pkg: { name: NAME, version: '2.3.0-rc.3' }, ref: 'refs/tags/v2.3.0-rc.3' }), /2\.3\.0 is already published/);
});

test('the git tag must match the package version', async () => {
    await assert.rejects(plan({ ref: 'refs/tags/v2.3.1' }), /Tag\/version mismatch/);
    await assert.rejects(plan({ ref: 'refs/heads/v2.3.0' }), /Tag\/version mismatch/);
});

test('an already published version is never published again', async () => {
    await assert.rejects(plan({ registry: registry({ versions: ['2.3.0', '2.3.0-rc.2'] }) }), /already published/);
});

test('npmRegistry reads versions, dist-tags, deprecation and provenance from the registry', async () => {
    const calls = [];
    const payload = Buffer.from(JSON.stringify({
        predicate: { buildDefinition: {
            externalParameters: { workflow: { repository: REPOSITORY_URL, path: WORKFLOW_PATH, ref: 'refs/tags/v2.3.0-rc.1' } },
            resolvedDependencies: [{ digest: { gitCommit: RC_COMMIT } }],
        } },
    })).toString('base64');
    const responses = {
        [`https://registry.npmjs.org/${NAME}`]: {
            'dist-tags': { rc: '2.3.0-rc.1' },
            versions: {
                '2.3.0-rc.1': { dist: { attestations: { url: `https://registry.npmjs.org/-/npm/v1/attestations/${NAME}@2.3.0-rc.1` } } },
                '2.2.0-rc.1': { deprecated: 'old', dist: { attestations: { url: 'https://evil.example/att' } } },
            },
        },
        [`https://registry.npmjs.org/-/npm/v1/attestations/${NAME}@2.3.0-rc.1`]: {
            attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload } } }],
        },
    };
    const fetchImpl = async (url) => {
        calls.push(url);
        const body = responses[url];
        return { status: body ? 200 : 404, ok: Boolean(body), json: async () => body };
    };
    const reg = await npmRegistry(NAME, fetchImpl);
    assert.deepEqual(reg.versions, ['2.3.0-rc.1', '2.2.0-rc.1']);
    assert.deepEqual(reg.distTags, { rc: '2.3.0-rc.1' });
    assert.deepEqual(await reg.release('2.3.0-rc.1'), { deprecated: undefined, provenance: source('2.3.0-rc.1') });
    // An attestation URL outside the registry is not followed.
    assert.deepEqual(await reg.release('2.2.0-rc.1'), { deprecated: 'old', provenance: null });
    assert.equal(await reg.release('9.9.9'), null);
    // Every request went to the registry host: nothing else was fetched.
    assert.deepEqual(calls.filter((url) => new URL(url).hostname !== 'registry.npmjs.org'), []);

    const unknown = await npmRegistry('not-published', fetchImpl);
    assert.deepEqual([unknown.versions, unknown.distTags], [[], {}]);
    const failing = async () => ({ status: 500, ok: false });
    await assert.rejects(npmRegistry(NAME, failing), /HTTP 500/);
});

// The real git wiring and the CLI, on a throw-away repository: the rc commit,
// a later commit, and the stable commit with or without a lockfile change.
function scratchRepo(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-guard-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.invalid');
    run('config', 'user.name', 'test');
    run('config', 'commit.gpgsign', 'false');
    run('config', 'tag.gpgsign', 'false');
    const write = (version, lock) => {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: NAME, version, dependencies: { ws: '^8.14.2' } }));
        fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lock }));
    };
    const commit = (message) => (run('add', '-A'), run('commit', '-q', '-m', message), run('rev-parse', 'HEAD'));
    return { dir, run, write, commit };
}

test('makeGit answers tag, ancestry and lockfile questions on a real repository', (t) => {
    const repo = scratchRepo(t);
    repo.write('2.3.0-rc.2', 1);
    const rc = repo.commit('rc');
    repo.run('tag', '-a', 'v2.3.0-rc.2', '-m', 'annotated');
    repo.write('2.3.0', 1);
    repo.commit('stable');
    const g = makeGit(repo.dir);
    assert.equal(g.commitOf('v2.3.0-rc.2'), rc, 'an annotated tag resolves to its commit');
    assert.equal(g.commitOf('v9.9.9'), null);
    assert.equal(g.isAncestor(rc), true);
    assert.equal(g.lockfileChangedSince(rc), false);
    assert.equal(g.packageJsonAt(rc).version, '2.3.0-rc.2');

    repo.write('2.3.0', 2);
    repo.commit('lockfile change');
    assert.equal(g.lockfileChangedSince(rc), true);

    repo.run('checkout', '-q', '--orphan', 'elsewhere');
    repo.write('2.3.0', 1);
    repo.commit('unrelated');
    assert.equal(g.isAncestor(rc), false);
    assert.throws(() => g.isAncestor('f'.repeat(40)), /Command failed/);
});

test('the CLI writes name, version and dist-tag to GITHUB_OUTPUT, and nothing when refused', async (t) => {
    const repo = scratchRepo(t);
    repo.write('2.3.0-rc.2', 1);
    const rc = repo.commit('rc');
    repo.run('tag', 'v2.3.0-rc.2');
    repo.write('2.3.0', 1);
    repo.commit('stable');
    const output = path.join(repo.dir, 'github-output');
    const reg = registry({ releases: { '2.3.0-rc.2': { provenance: source('2.3.0-rc.2', { commit: rc }) } } });
    const env = { GITHUB_REF: 'refs/tags/v2.3.0', GITHUB_OUTPUT: output };
    const log = t.mock.method(console, 'log', () => {});

    assert.equal((await main({ env, cwd: repo.dir, registry: reg })).tag, 'latest');
    assert.equal(fs.readFileSync(output, 'utf8'), `name=${NAME}\nversion=2.3.0\ntag=latest\n`);
    assert.match(log.mock.calls[0].arguments[0], /-> npm dist-tag "latest" \(validated as 2\.3\.0-rc\.2\)/);

    fs.rmSync(output);
    repo.write('2.3.0', 2);
    repo.commit('lockfile change after the rc');
    await assert.rejects(main({ env, cwd: repo.dir, registry: reg }), /differs from 2\.3\.0-rc\.2 in package-lock\.json/);
    assert.equal(fs.existsSync(output), false);

    await assert.rejects(main({ env: {}, argv: [], cwd: repo.dir, registry: reg }), /GITHUB_REF/);

    repo.write('2.3.1-rc.1', 2);
    repo.commit('next rc');
    await main({ env: { GITHUB_REF: 'refs/tags/v2.3.1-rc.1', GITHUB_OUTPUT: output }, cwd: repo.dir, registry: reg });
    assert.equal(fs.readFileSync(output, 'utf8'), `name=${NAME}\nversion=2.3.1-rc.1\ntag=rc\n`);
});
