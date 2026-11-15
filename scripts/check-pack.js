#!/usr/bin/env node
'use strict';

// Verifies the npm tarball against an allowlist before it is published.
//
//   node scripts/check-pack.js [package.tgz]
//
// Without an argument it runs `npm pack` into a temporary directory first (which
// triggers `prepack`, the clean release build). With one it checks exactly that
// file: the release workflow passes the tarball it is about to publish.
//
// Source maps are deliberately not published: `src/` is not in the package, so a
// map could only point at files that do not exist. This gate keeps it that way.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ALLOWED_ROOT_FILES = new Set([
    'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'config.schema.json',
]);
// dist/ holds the compiled modules and their declarations, nothing else.
const DIST_FILE = /^dist\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|d\.ts)$/;
// Scripts npm runs on the machine of whoever installs the package: on a
// registry install (pre/post/install) or a git install (prepare and its hooks).
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare'];

/**
 * @param {string[]} entries paths inside the tarball, relative to the package root
 * @param {object} pkg the package.json shipped in the tarball
 * @returns {string[]} one message per violation
 */
function checkEntries(entries, pkg) {
    const problems = [];
    const set = new Set(entries);

    for (const entry of entries) {
        if (entry.endsWith('.map')) problems.push(`source map in the package: ${entry}`);
        else if (!ALLOWED_ROOT_FILES.has(entry) && !DIST_FILE.test(entry)) {
            problems.push(`unexpected file in the package: ${entry}`);
        }
    }
    for (const required of [...ALLOWED_ROOT_FILES, pkg.main, 'dist/index.d.ts']) {
        if (!set.has(required)) problems.push(`missing from the package: ${required}`);
    }
    for (const script of LIFECYCLE_SCRIPTS) {
        if (pkg.scripts && pkg.scripts[script]) problems.push(`package.json defines the install-time script "${script}"`);
    }
    // A binding.gyp makes npm run `node-gyp rebuild` at install even without a script.
    if (pkg.gypfile) problems.push('package.json sets "gypfile": npm would build native code at install');
    // A plugin has no command line: nothing to link into the user's PATH.
    if (pkg.bin || pkg.directories?.bin) problems.push('package.json declares executables ("bin")');
    return problems;
}

/**
 * dist/ entries with no source file behind them: leftovers of a removed or
 * renamed module that a build which does not start clean keeps around.
 * @param {string[]} entries paths inside the tarball
 * @param {(relativeSource: string) => boolean} sourceExists is there src/<relativeSource>?
 */
function orphanedDistEntries(entries, sourceExists) {
    return entries
        .filter((entry) => entry.startsWith('dist/') && /\.(js|d\.ts)$/.test(entry))
        .filter((entry) => !sourceExists(entry.slice('dist/'.length).replace(/(\.d)?\.js$|\.d\.ts$/, '.ts')));
}

function distScriptsWithSourceMapComment(root, entries) {
    return entries
        .filter((entry) => entry.startsWith('dist/') && entry.endsWith('.js'))
        .filter((entry) => /^\/\/# sourceMappingURL=/m.test(fs.readFileSync(path.join(root, entry), 'utf8')));
}

function packTarball(destination) {
    // Lifecycle output (the build) goes to stderr so stdout stays the file name.
    const out = execFileSync('npm', ['pack', '--pack-destination', destination, '--silent'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    });
    return path.join(destination, out.trim().split('\n').pop());
}

/**
 * Lists a tarball's members with their type, refusing anything but regular
 * files and directories (links would make the walk below read outside it).
 */
function tarballMembers(tarball) {
    const listing = execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return listing.split('\n').filter(Boolean).map((line) => ({ type: line[0], line }));
}

/**
 * @param {string} tarball path of the .tgz to check
 * @param {{srcRoot?: string, workdir: string}} options
 * @returns {{problems: string[], entries: string[]}}
 */
function checkTarball(tarball, { srcRoot = path.resolve(__dirname, '..', 'src'), workdir }) {
    const problems = tarballMembers(tarball)
        .filter((member) => member.type !== '-' && member.type !== 'd')
        .map((member) => `not a regular file in the package: ${member.line}`);
    if (problems.length > 0) return { problems, entries: [] };

    const extracted = path.join(workdir, 'extracted');
    fs.mkdirSync(extracted);
    execFileSync('tar', ['-xzf', tarball, '-C', extracted]);
    const top = fs.readdirSync(extracted);
    if (top.length !== 1 || top[0] !== 'package') {
        return { problems: [`the tarball must contain only package/, found: ${top.join(', ')}`], entries: [] };
    }

    const root = path.join(extracted, 'package');
    const entries = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) walk(abs);
        else entries.push(path.relative(root, abs).split(path.sep).join('/'));
    });
    walk(root);

    let pkg = {};
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    } catch (error) {
        problems.push(`package.json is missing or not valid JSON: ${error.message}`);
    }
    problems.push(...checkEntries(entries, pkg));
    distScriptsWithSourceMapComment(root, entries)
        .forEach((entry) => problems.push(`${entry} still points at a source map that is not published`));
    if (!fs.existsSync(srcRoot)) problems.push(`cannot check dist/ against the sources: ${srcRoot} is missing`);
    else {
        orphanedDistEntries(entries, (rel) => fs.existsSync(path.join(srcRoot, rel)))
            .forEach((entry) => problems.push(`${entry} has no source file in src/ (stale build output)`));
    }
    try {
        JSON.parse(fs.readFileSync(path.join(root, 'config.schema.json'), 'utf8'));
    } catch (error) {
        problems.push(`config.schema.json is not valid JSON: ${error.message}`);
    }
    return { problems, entries };
}

function main() {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-pack-'));
    try {
        const tarball = path.resolve(process.argv[2] ?? packTarball(workdir));
        const { problems, entries } = checkTarball(tarball, { workdir });
        if (problems.length > 0) {
            console.error(`${path.basename(tarball)}: ${problems.length} problem(s)`);
            problems.forEach((p) => console.error(`- ${p}`));
            process.exitCode = 1;
            return;
        }
        console.log(`${path.basename(tarball)}: ${entries.length} files, ${fs.statSync(tarball).size} bytes, allowlist ok`);
    } finally {
        fs.rmSync(workdir, { recursive: true, force: true });
    }
}

if (require.main === module) main();

module.exports = { checkEntries, orphanedDistEntries, checkTarball };
