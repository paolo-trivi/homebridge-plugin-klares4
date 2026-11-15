#!/usr/bin/env node
'use strict';

// Release gate, run by the release workflow before anything is built or
// published. It decides the npm dist-tag from the version and refuses a stable
// release that was not validated as a release candidate:
//
//   - the package is homebridge-plugin-klares4 and the git tag is
//     `v<package.json version>`;
//   - the version must be a stable one or `-rc.N` / `-beta.N` (anything else
//     would silently land on `latest`);
//   - a version that is already on the registry is never published again, and
//     a dist-tag never moves back to an older version;
//   - a stable `X.Y.Z` needs a published, not deprecated `X.Y.Z-rc.N` whose npm
//     provenance says it was built by this repository's release workflow from
//     the tag `vX.Y.Z-rc.N`. The rc is identified by the commit in that
//     provenance, not by the git tag alone (a tag can be moved): the tag must
//     still point at that commit, the stable must descend from it, and neither
//     the lockfile nor the dependency fields of package.json may differ from
//     it, so a dependency or compiler change after the last rc forces a new rc.
//
// The decision logic is exported for tests; the CLI wires it to the registry
// and to git. It writes name, version and tag to $GITHUB_OUTPUT when set.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_NAME = 'homebridge-plugin-klares4';
const REPOSITORY_URL = 'https://github.com/paolo-trivi/homebridge-plugin-klares4';
const WORKFLOW_PATH = '.github/workflows/release-publish.yml';
const REGISTRY = 'https://registry.npmjs.org';
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(rc|beta)\.(\d+))?$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
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

/** Semantic Versioning precedence; null when either side is not a version. */
function compareVersions(a, b) {
    const ma = SEMVER.exec(a);
    const mb = SEMVER.exec(b);
    if (!ma || !mb) return null;
    for (let i = 1; i <= 3; i += 1) {
        const diff = Number(ma[i]) - Number(mb[i]);
        if (diff !== 0) return Math.sign(diff);
    }
    if (ma[4] === undefined || mb[4] === undefined) {
        return ma[4] === mb[4] ? 0 : (ma[4] === undefined ? 1 : -1);
    }
    const pa = ma[4].split('.');
    const pb = mb[4].split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        if (pa[i] === undefined) return -1;
        if (pb[i] === undefined) return 1;
        const na = /^\d+$/.test(pa[i]);
        const nb = /^\d+$/.test(pb[i]);
        if (na && nb && Number(pa[i]) !== Number(pb[i])) return Math.sign(Number(pa[i]) - Number(pb[i]));
        if (na !== nb) return na ? -1 : 1;
        if (!na && pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    }
    return 0;
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
 * Where a published version was built, from the SLSA provenance npm stores
 * next to it (`GET /-/npm/v1/attestations/<name>@<version>`). The registry
 * verified the attestation when the version was published.
 * @returns {{repository: string, workflowPath: string, ref: string, commit: string}|null}
 */
function provenanceSource(attestations) {
    for (const entry of attestations?.attestations ?? []) {
        if (entry?.predicateType !== SLSA_PROVENANCE) continue;
        const payload = entry.bundle?.dsseEnvelope?.payload;
        if (typeof payload !== 'string') continue;
        const statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
        const definition = statement?.predicate?.buildDefinition;
        const workflow = definition?.externalParameters?.workflow;
        const commit = definition?.resolvedDependencies?.[0]?.digest?.gitCommit;
        if (!workflow || typeof commit !== 'string') continue;
        return { repository: workflow.repository, workflowPath: workflow.path, ref: workflow.ref, commit };
    }
    return null;
}

/**
 * The commit a release candidate was built from, after checking that it was
 * built by this repository's release workflow from its own tag.
 */
function releaseCandidateCommit(rc, release) {
    if (!release) throw new Error(`${rc} is listed by the registry but its metadata could not be read.`);
    if (release.deprecated) {
        throw new Error(`${rc} is deprecated on npm ("${release.deprecated}"): publish a new release candidate.`);
    }
    const source = release.provenance;
    if (!source) {
        throw new Error(`${rc} has no npm provenance: there is no proof of the commit it was built from. Publish a new release candidate.`);
    }
    const expected = { repository: REPOSITORY_URL, workflowPath: WORKFLOW_PATH, ref: `refs/tags/v${rc}` };
    for (const [key, value] of Object.entries(expected)) {
        if (source[key] !== value) {
            throw new Error(`The provenance of ${rc} has ${key}=${source[key]}, expected ${value}: it was not built by this release workflow.`);
        }
    }
    if (!COMMIT.test(source.commit)) throw new Error(`The provenance of ${rc} has no valid commit: ${source.commit}`);
    return source.commit;
}

/**
 * @param {object} input
 * @param {{name: string, version: string}} input.pkg package.json of the tagged commit
 * @param {string} input.ref GITHUB_REF (refs/tags/vX.Y.Z)
 * @param {{versions: string[], distTags: Record<string, string>,
 *          release(version: string): Promise<{deprecated?: string,
 *              provenance: ReturnType<typeof provenanceSource>}|null>}} input.registry
 * @param {{commitOf(tag: string): string|null, isAncestor(commit: string): boolean,
 *          lockfileChangedSince(commit: string): boolean, packageJsonAt(commit: string): object}} input.git
 * @returns {Promise<{name: string, version: string, tag: string, rc: string|null}>}
 */
async function planRelease({ pkg, ref, registry, git }) {
    const { name, version } = pkg;
    if (name !== PACKAGE_NAME) throw new Error(`This workflow publishes ${PACKAGE_NAME} only, package.json says "${name}".`);
    const { base, channel, stable } = classifyVersion(version);

    const gitTag = ref.replace(/^refs\/tags\//, '');
    if (gitTag !== `v${version}`) {
        throw new Error(`Tag/version mismatch: git tag=${gitTag} package.json=${version}`);
    }
    if (registry.versions.includes(version)) {
        throw new Error(`Version already published: ${name}@${version}`);
    }
    const current = registry.distTags[channel];
    if (current !== undefined && compareVersions(version, current) === -1) {
        throw new Error(`${version} is older than ${current}, which the dist-tag "${channel}" points at: it would move "${channel}" back.`);
    }
    if (!stable) {
        if (registry.versions.includes(base)) throw new Error(`${base} is already published: a ${channel} of it would never be installed.`);
        return { name, version, tag: channel, rc: null };
    }

    const rc = latestRc(registry.versions, base);
    if (!rc) {
        throw new Error(
            `${name}@${version} has no published release candidate (${base}-rc.N). ` +
            'Publish an rc first, validate it, then tag the stable on the same dependencies.',
        );
    }
    const rcCommit = releaseCandidateCommit(rc, await registry.release(rc));
    const tagCommit = git.commitOf(`v${rc}`);
    if (!tagCommit) {
        throw new Error(`The git tag v${rc} is missing: cannot compare ${version} with the release candidate.`);
    }
    if (tagCommit !== rcCommit) {
        throw new Error(`The git tag v${rc} points at ${tagCommit}, but ${rc} was published from ${rcCommit}: the tag was moved.`);
    }
    if (!git.isAncestor(rcCommit)) {
        throw new Error(`${version} does not descend from ${rcCommit}, the commit ${rc} was published from.`);
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

function makeGit(cwd) {
    const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // Exit status 1 is the answer "no"; anything else is a failure.
    const yes = (args) => {
        try {
            git(args);
            return true;
        } catch (error) {
            if (error.status === 1) return false;
            throw error;
        }
    };
    return {
        commitOf(tag) {
            try {
                return git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).trim();
            } catch {
                return null;
            }
        },
        isAncestor: (commit) => yes(['merge-base', '--is-ancestor', commit, 'HEAD']),
        lockfileChangedSince: (commit) => !yes(['diff', '--quiet', commit, 'HEAD', '--', 'package-lock.json']),
        packageJsonAt: (commit) => JSON.parse(git(['show', `${commit}:package.json`])),
    };
}

async function getJson(url, fetchImpl) {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
    return response.json();
}

async function npmRegistry(name, fetchImpl = fetch) {
    const packument = await getJson(`${REGISTRY}/${encodeURIComponent(name)}`, fetchImpl);
    const manifests = packument?.versions ?? {};
    return {
        versions: Object.keys(manifests),
        distTags: packument?.['dist-tags'] ?? {},
        async release(version) {
            const manifest = manifests[version];
            if (!manifest) return null;
            const url = manifest.dist?.attestations?.url;
            const attestations = typeof url === 'string' && url.startsWith(`${REGISTRY}/`) ? await getJson(url, fetchImpl) : null;
            return { deprecated: manifest.deprecated, provenance: provenanceSource(attestations) };
        },
    };
}

async function main({ env = process.env, argv = process.argv, cwd = process.cwd(), registry, git } = {}) {
    const ref = env.GITHUB_REF ?? argv[2];
    if (!ref) throw new Error('GITHUB_REF (or a ref argument) is required');
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const plan = await planRelease({
        pkg, ref, registry: registry ?? await npmRegistry(pkg.name), git: git ?? makeGit(cwd),
    });

    console.log(`Release ${plan.name}@${plan.version} -> npm dist-tag "${plan.tag}"` +
        (plan.rc ? ` (validated as ${plan.rc})` : ''));
    if (env.GITHUB_OUTPUT) {
        fs.appendFileSync(env.GITHUB_OUTPUT, `name=${plan.name}\nversion=${plan.version}\ntag=${plan.tag}\n`);
    }
    return plan;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`::error::${error.message}`);
        process.exit(1);
    });
}

module.exports = {
    classifyVersion, compareVersions, latestRc, changedDependencyFields, provenanceSource,
    planRelease, makeGit, npmRegistry, main, PACKAGE_NAME, REPOSITORY_URL, WORKFLOW_PATH,
};
