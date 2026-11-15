#!/usr/bin/env node
'use strict';

// Runs the whole suite in two phases so the tests that boot the real Homebridge
// Matter stack never compete with the rest.
//
//   node scripts/run-tests.js                   every test file
//   node scripts/run-tests.js --real-stack-only only the real-stack files
//   node scripts/run-tests.js --no-real-stack   every file but the real-stack ones
//     (for a Node version on which matter.js cannot be installed)
//
// `node --test --test-timeout` is a per-file budget as well as a per-test one,
// and a file that boots matter.js is CPU-heavy: on a small or busy runner (or
// with coverage on) it runs out of a flat 30 s although nothing is wrong. So the
// ordinary files run in parallel with the short timeout, which still catches a
// hang quickly, and the real-stack files run one at a time with a long one.
//
// A file is a real-stack file when, following its relative `require()` /
// `import()` calls through the fixtures it loads, it reaches
// `test/fixtures/real-matter-stack.js`. test/run-tests-plan.test.js checks the
// classification against an independent scan, so a new way of loading the
// harness that this parser does not follow fails the suite instead of silently
// landing in the wrong phase.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = path.resolve(__dirname, '..', 'test');
const LIGHT_TIMEOUT_MS = 60000;
const REAL_STACK_TIMEOUT_MS = 120000;
const HARNESS = path.join(TEST_DIR, 'fixtures', 'real-matter-stack.js');
const LOCAL_LOAD = /(?:require|import)\(\s*(['"`])(\.{1,2}\/[^'"`]+)\1\s*\)/g;

function listTestFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) return listTestFiles(abs);
            return entry.name.endsWith('.test.js') ? [abs] : [];
        })
        .sort();
}

const realFs = {
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    isFile: (file) => fs.existsSync(file) && fs.statSync(file).isFile(),
};

function resolveLocal(fromFile, specifier, isFile) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    return [base, `${base}.js`, path.join(base, 'index.js')].find(isFile) ?? null;
}

function reachesHarness(file, io, seen = new Set()) {
    if (file === HARNESS) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    const source = io.readFile(file);
    for (const match of source.matchAll(LOCAL_LOAD)) {
        const target = resolveLocal(file, match[2], io.isFile);
        if (target && reachesHarness(target, io, seen)) return true;
    }
    return false;
}

/** @returns {{light: string[], realStack: string[]}} */
function planTestRuns(files, io = realFs) {
    const realStack = files.filter((file) => reachesHarness(file, io));
    const heavy = new Set(realStack);
    return { light: files.filter((file) => !heavy.has(file)), realStack };
}

function runNodeTest(files, extraArgs) {
    if (files.length === 0) return 0;
    const result = spawnSync(process.execPath, ['--test', ...extraArgs, ...files], { stdio: 'inherit' });
    return result.status ?? 1;
}

function main() {
    const realStackOnly = process.argv.includes('--real-stack-only');
    const noRealStack = process.argv.includes('--no-real-stack');
    if (realStackOnly && noRealStack) {
        console.error('--real-stack-only and --no-real-stack exclude each other: nothing would run');
        process.exitCode = 2;
        return;
    }
    const { light, realStack } = planTestRuns(listTestFiles(TEST_DIR));
    const statuses = [];
    if (!realStackOnly) statuses.push(runNodeTest(light, [`--test-timeout=${LIGHT_TIMEOUT_MS}`]));
    if (noRealStack) console.log(`# ${realStack.length} real-stack test file(s) not run (--no-real-stack)`);
    else statuses.push(runNodeTest(realStack, ['--test-concurrency=1', `--test-timeout=${REAL_STACK_TIMEOUT_MS}`]));
    process.exitCode = statuses.some((status) => status !== 0) ? 1 : 0;
}

if (require.main === module) main();

module.exports = { planTestRuns, listTestFiles, HARNESS, TEST_DIR };
