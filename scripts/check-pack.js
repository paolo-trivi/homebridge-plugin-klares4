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
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/**
 * @param {string[]} entries paths inside the tarball, relative to the package root
 * @param {object} pkg the package.json shipped in the tarball
 * @returns {string[]} one message per violation
 */
function checkEntries(entries, pkg) {
    const problems = [];
    const set = new Set(entries);

    for (const entry of entries) {
        const top = entry.split('/')[0];
        if (top !== 'dist' && !(ALLOWED_ROOT_FILES.has(entry))) {
            problems.push(`unexpected file in the package: ${entry}`);
        }
        if (entry.endsWith('.map')) problems.push(`source map in the package: ${entry}`);
    }
    for (const required of [...ALLOWED_ROOT_FILES, pkg.main, 'dist/index.d.ts']) {
        if (!set.has(required)) problems.push(`missing from the package: ${required}`);
    }
    for (const script of LIFECYCLE_SCRIPTS) {
        if (pkg.scripts && pkg.scripts[script]) problems.push(`package.json defines the install-time script "${script}"`);
    }
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

function main() {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-pack-'));
    try {
        const tarball = path.resolve(process.argv[2] ?? packTarball(workdir));
        const extracted = path.join(workdir, 'extracted');
        fs.mkdirSync(extracted);
        execFileSync('tar', ['-xzf', tarball, '-C', extracted]);

        const root = path.join(extracted, 'package');
        const entries = [];
        const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
            const abs = path.join(dir, d.name);
            if (d.isDirectory()) walk(abs);
            else entries.push(path.relative(root, abs).split(path.sep).join('/'));
        });
        walk(root);

        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const problems = checkEntries(entries, pkg);
        distScriptsWithSourceMapComment(root, entries)
            .forEach((entry) => problems.push(`${entry} still points at a source map that is not published`));
        const srcRoot = path.resolve(__dirname, '..', 'src');
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

module.exports = { checkEntries, orphanedDistEntries };
