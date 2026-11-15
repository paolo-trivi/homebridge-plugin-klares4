'use strict';

// The CI/CD rules that keep a dependency, an action or a pull request from
// reaching the npm token or the published tarball. Each one is checked on the
// workflow files themselves, so removing it fails the suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const workflows = Object.fromEntries(fs.readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8')]));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

/** The text of each job (`jobs:` children at two spaces of indentation). */
function jobs(source) {
    const lines = source.split('\n');
    const start = lines.indexOf('jobs:');
    const result = {};
    let current = null;
    for (const line of lines.slice(start + 1)) {
        const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
        if (match) result[(current = match[1])] = '';
        else if (/^\S/.test(line)) current = null;
        else if (current) result[current] += `${line}\n`;
    }
    return result;
}

/** The shell of every `run:` step, inline or block. */
function runScripts(source) {
    const scripts = [];
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
        if (!match) continue;
        if (!/^[|>]/.test(match[2])) {
            scripts.push(match[2]);
            continue;
        }
        const body = [];
        const indent = match[1].length;
        while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s*/.exec(lines[i + 1])[0].length > indent)) {
            body.push(lines[(i += 1)]);
        }
        scripts.push(body.join('\n'));
    }
    return scripts;
}

test('every action is pinned by a full commit SHA with its version in a comment', () => {
    for (const [file, source] of Object.entries(workflows)) {
        for (const line of source.split('\n').filter((l) => /^\s*(?:- )?uses:/.test(l))) {
            assert.match(line, /uses: [\w.-]+\/[\w.\/-]+@[0-9a-f]{40} # v\d+(?:\.\d+)*$/, `${file}: ${line.trim()}`);
        }
    }
});

test('every checkout leaves no credentials behind', () => {
    for (const [file, source] of Object.entries(workflows)) {
        const checkouts = source.match(/uses: actions\/checkout@/g)?.length ?? 0;
        const without = source.match(/persist-credentials: false/g)?.length ?? 0;
        assert.equal(without, checkouts, file);
    }
});

test('every workflow starts from no permissions or read-only contents', () => {
    for (const [file, source] of Object.entries(workflows)) {
        assert.match(source, /^permissions:(?: \{\}|\n {2}contents: read)\n/m, file);
    }
});

test('no install runs package scripts, and nothing is fetched through npx', () => {
    for (const [file, source] of Object.entries(workflows)) {
        for (const script of runScripts(source)) {
            for (const line of script.split('\n').filter((l) => /\bnpm (?:ci|install|i)\b/.test(l))) {
                assert.match(line, /--ignore-scripts/, `${file}: ${line.trim()}`);
            }
            assert.doesNotMatch(script, /\bnpx\b/, file);
        }
    }
    for (const [name, script] of Object.entries(pkg.scripts)) assert.doesNotMatch(script, /\bnpx\b/, name);
});

test('no expression is expanded inside a shell script: values go through env', () => {
    for (const [file, source] of Object.entries(workflows)) {
        for (const script of runScripts(source)) assert.doesNotMatch(script, /\$\{\{/, `${file}: ${script.trim()}`);
    }
});

test('only the publish job can ask for an OIDC token', () => {
    for (const [file, source] of Object.entries(workflows)) {
        const tokens = source.match(/id-token: write/g)?.length ?? 0;
        assert.equal(tokens, file === 'release-publish.yml' ? 1 : 0, file);
    }
    const release = jobs(workflows['release-publish.yml']);
    assert.match(release.publish, /id-token: write/);
    assert.match(release.publish, /environment: npm-publish/);
});

test('pull_request_target is used only by the auto-merge workflow, which runs nothing from the PR', () => {
    for (const [file, source] of Object.entries(workflows)) {
        if (file === 'dependabot-auto-merge.yml') continue;
        assert.doesNotMatch(source, /pull_request_target|workflow_run/, file);
    }
    const autoMerge = workflows['dependabot-auto-merge.yml'];
    assert.doesNotMatch(autoMerge, /actions\/checkout/);
    for (const script of runScripts(autoMerge)) {
        assert.doesNotMatch(script, /(?:^|[;&|(]|\$\()\s*(?:npm|npx|node|git|sh|bash)\s/m, script);
    }
});

test('the release builds the tarball without running the tests or any dependency but the compiler', () => {
    const release = jobs(workflows['release-publish.yml']);
    assert.deepEqual(Object.keys(release), ['build', 'test', 'publish']);
    assert.doesNotMatch(release.build, /npm (?:run )?(?:verify|test)|run-tests|homebridge/);
    assert.match(release.build, /node scripts\/release-guard\.js/);
    assert.match(release.build, /node scripts\/check-pack\.js/);
    assert.match(release.build, /readlink -f node_modules\/\.bin\/tsc/);
    assert.match(release.test, /npm run verify/);
    assert.doesNotMatch(release.test, /upload-artifact|outputs:/);
    assert.equal(pkg.scripts.prepack, 'npm run build:release');
    assert.equal(pkg.scripts.build, 'tsc');
    assert.equal(pkg.scripts.prebuild, 'node scripts/clean-dist.js');
});

test('the publish job takes the build artifact by ID and checks the digest the build job reported', () => {
    const { publish } = jobs(workflows['release-publish.yml']);
    assert.match(publish, /needs: \[build, test\]/);
    assert.match(publish, /artifact-ids: \$\{\{ needs\.build\.outputs\.artifact-id \}\}/);
    assert.doesNotMatch(publish, /^\s+name: release-tarball/m);
    const verify = publish.slice(publish.indexOf('- name: Verify the tarball'), publish.indexOf('- name: Re-check'));
    assert.match(verify, /SHA256: \$\{\{ needs\.build\.outputs\.sha256 \}\}/);
    assert.match(verify, /echo "\$\{SHA256\}  \$\{TARBALL\}" \| sha256sum --check --strict/);
    assert.doesNotMatch(publish, /actions\/checkout|npm ci|npm install|npm run/);
});

test('no release job restores a cache', () => {
    const source = workflows['release-publish.yml'];
    assert.doesNotMatch(source, /^\s+cache:/m);
    const setups = source.match(/uses: actions\/setup-node@/g).length;
    assert.equal(source.match(/package-manager-cache: false/g).length, setups);
});

test('auto-merge takes only single-commit npm development updates from Dependabot itself', () => {
    const source = workflows['dependabot-auto-merge.yml'];
    assert.match(source, /github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'/);
    assert.match(source, /github\.actor == 'dependabot\[bot\]'/);
    assert.match(source, /github\.event\.pull_request\.commits == 1/);
    assert.match(source, /\.dependencyType == "direct:development"\)/);
    assert.doesNotMatch(source, /github[_-]actions"/);
    assert.match(source, /REVIEWED_PACKAGES: '\^\(typescript\|@types\/\.\+\)\$'/);
    assert.match(source, /grep -qvxE 'package\\\.json\|package-lock\\\.json'/);
    assert.match(source, /--match-head-commit "\$HEAD_SHA"/);
});

test('the lockfile installs only from the npm registry, with integrity, and without install scripts', () => {
    assert.equal(lock.lockfileVersion, 3);
    const tscProviders = [];
    for (const [location, entry] of Object.entries(lock.packages)) {
        if (location === '') continue;
        assert.ok(!entry.link, `${location} is a link`);
        assert.match(entry.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//, location);
        assert.match(entry.integrity ?? '', /^sha512-/, location);
        // `npm ci --ignore-scripts` would skip them, but a new one deserves a look.
        assert.ok(!entry.hasInstallScript, `${location} has an install script`);
        if (entry.bin && Object.hasOwn(entry.bin, 'tsc')) tscProviders.push(location);
    }
    assert.deepEqual(tscProviders, ['node_modules/typescript']);
});
