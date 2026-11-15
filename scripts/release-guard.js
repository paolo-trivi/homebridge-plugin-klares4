#!/usr/bin/env node
'use strict';

// Release gate, run by the release workflow before anything is built or
// published. It decides the npm dist-tag from the version and refuses a stable
// release that is not the build that was validated as a release candidate:
//
//   - the git tag must be `v<package.json version>`;
//   - the version must be a stable one or `-rc.N` / `-beta.N` (anything else
//     would silently land on `latest`);
//   - a stable `X.Y.Z` needs a published `X.Y.Z-rc.N`, and neither the lockfile
//     nor the dependency fields of package.json may differ from that rc, so a
//     dependency or compiler change after the last rc forces a new rc;
//   - a version that is already on the registry is never published again.
//
// Pure decision logic is exported for tests; the CLI wires it to `npm view`
// and `git`. It writes name, version and tag to $GITHUB_OUTPUT when set.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(rc|beta)\.(\d+))?$/;
const DEPENDENCY_FIELDS = [
    'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides',
];

function classifyVersion(version) {
    const match = VERSION.exec(version);
    if (!match) {
        throw new Error(
            `Unsupported version "${version}": use X.Y.Z, X.Y.Z-rc.N or X.Y.Z-beta.N, with the dot before N ` +
            '(for example 2.3.0-rc.1, not 2.3.0-rc1). Other pre-release names would be published on the wrong dist-tag, ' +
            'and a stable release only recognizes release candidates written -rc.N.',
        );
    }
    const base = `${match[1]}.${match[2]}.${match[3]}`;
    return { base, channel: match[4] ?? 'latest', stable: match[4] === undefined };
}

function rcNumbers(publishedVersions, base) {
    const prefix = `${base}-rc.`;
    return publishedVersions
        .filter((v) => v.startsWith(prefix) && /^\d+$/.test(v.slice(prefix.length)))
        .map((v) => Number(v.slice(prefix.length)))
        .sort((a, b) => a - b);
}

function latestRc(publishedVersions, base) {
    const numbers = rcNumbers(publishedVersions, base);
    return numbers.length > 0 ? `${base}-rc.${numbers[numbers.length - 1]}` : null;
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
    }
    return value;
}

function changedDependencyFields(before, after) {
    return DEPENDENCY_FIELDS.filter(
        (field) => JSON.stringify(canonical(before[field] ?? null)) !== JSON.stringify(canonical(after[field] ?? null)),
    );
}

/**
 * @param {object} input
 * @param {{name: string, version: string}} input.pkg package.json of the tagged commit
 * @param {string} input.ref GITHUB_REF (refs/tags/vX.Y.Z)
 * @param {string[]} input.publishedVersions every version already on the registry
 * @param {{commitOf(tag: string): string|null, lockfileChangedSince(commit: string): boolean,
 *          packageJsonAt(commit: string): object}} input.git
 * @returns {{name: string, version: string, tag: string, rc: string|null}}
 */
function planRelease({ pkg, ref, publishedVersions, git }) {
    const { name, version } = pkg;
    const { base, channel, stable } = classifyVersion(version);

    const gitTag = ref.replace(/^refs\/tags\//, '');
    if (gitTag !== `v${version}`) {
        throw new Error(`Tag/version mismatch: git tag=${gitTag} package.json=${version}`);
    }
    if (publishedVersions.includes(version)) {
        throw new Error(`Version already published: ${name}@${version}`);
    }
    if (!stable) return { name, version, tag: channel, rc: null };

    const rc = latestRc(publishedVersions, base);
    if (!rc) {
        throw new Error(
            `${name}@${version} has no published release candidate (${base}-rc.N). ` +
            'Publish an rc first, validate it, then tag the stable on the same dependencies.',
        );
    }
    const rcCommit = git.commitOf(`v${rc}`);
    if (!rcCommit) {
        throw new Error(`The git tag v${rc} is missing: cannot compare ${version} with the release candidate.`);
    }
    const drift = [];
    if (git.lockfileChangedSince(rcCommit)) drift.push('package-lock.json');
    drift.push(...changedDependencyFields(git.packageJsonAt(rcCommit), pkg).map((f) => `package.json ${f}`));
    if (drift.length > 0) {
        throw new Error(
            `${version} differs from ${rc} in ${drift.join(', ')}. ` +
            'A dependency or compiler change after the last release candidate needs a new rc.',
        );
    }
    return { name, version, tag: 'latest', rc };
}

function run(file, args) {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function listPublishedVersions(name) {
    try {
        const parsed = JSON.parse(run('npm', ['view', name, 'versions', '--json']) || '[]');
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
        if (String(error.stderr ?? '').includes('E404')) return [];
        throw error;
    }
}

const realGit = {
    commitOf(tag) {
        try {
            return run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).trim();
        } catch {
            return null;
        }
    },
    lockfileChangedSince(commit) {
        try {
            run('git', ['diff', '--quiet', commit, 'HEAD', '--', 'package-lock.json']);
            return false;
        } catch (error) {
            if (error.status === 1) return true;
            throw error;
        }
    },
    packageJsonAt(commit) {
        return JSON.parse(run('git', ['show', `${commit}:package.json`]));
    },
};

function main() {
    const ref = process.env.GITHUB_REF ?? process.argv[2];
    if (!ref) throw new Error('GITHUB_REF (or a ref argument) is required');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const plan = planRelease({ pkg, ref, publishedVersions: listPublishedVersions(pkg.name), git: realGit });

    console.log(`Release ${plan.name}@${plan.version} -> npm dist-tag "${plan.tag}"` +
        (plan.rc ? ` (validated as ${plan.rc})` : ''));
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `name=${plan.name}\nversion=${plan.version}\ntag=${plan.tag}\n`);
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`::error::${error.message}`);
        process.exit(1);
    }
}

module.exports = { classifyVersion, latestRc, changedDependencyFields, planRelease, realGit };
