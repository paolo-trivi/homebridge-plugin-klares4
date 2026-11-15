'use strict';

// Small helpers to check the documentation: halves of a bilingual file,
// tables, code blocks, headings and relative links with their anchors.

const fs = require('node:fs');
const path = require('node:path');

/** The text between two level-2 headings: `[from, to)`, and from `to` to the end. */
function splitHalves(text, firstHeading, secondHeading) {
    const first = text.indexOf(`\n${firstHeading}\n`);
    const second = text.indexOf(`\n${secondHeading}\n`);
    if (first === -1 || second === -1 || second < first) throw new Error('bilingual headings not found');
    return { english: text.slice(first, second), italian: text.slice(second) };
}

/** Lines of `text` outside fenced code blocks. */
function proseLines(text) {
    const lines = [];
    let fenced = false;
    for (const line of text.split('\n')) {
        if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
        if (!fenced) lines.push(line);
    }
    return lines;
}

/** Data rows (cells, trimmed) of the first table after `heading`. */
function tableAfter(text, heading) {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line.trim() === heading);
    if (start === -1) throw new Error(`heading not found: ${heading}`);
    const rows = [];
    let inTable = false;
    for (const line of lines.slice(start + 1)) {
        if (/^\|.*\|\s*$/.test(line)) {
            inTable = true;
            rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()));
        } else if (inTable) {
            break;
        }
    }
    return rows.slice(2); // header and separator
}

/** Contents of every fenced code block, in order. */
function codeBlocks(text) {
    const blocks = [];
    let current;
    for (const line of text.split('\n')) {
        if (/^\s*```/.test(line)) {
            if (current === undefined) current = [];
            else { blocks.push(current.join('\n')); current = undefined; }
        } else if (current !== undefined) {
            current.push(line);
        }
    }
    return blocks;
}

function headings(text, level) {
    const marker = '#'.repeat(level);
    return proseLines(text).filter((line) => new RegExp(`^${marker} [^#]`).test(line)).map((line) => line.slice(level + 1).trim());
}

/** GitHub's heading anchors, with the `-1`, `-2` suffix of repeated headings. */
function anchors(text) {
    const seen = new Map();
    const result = new Set();
    for (const line of proseLines(text)) {
        const match = /^#{1,6} (.+)$/.exec(line);
        if (!match) continue;
        const base = match[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        result.add(count === 0 ? base : `${base}-${count}`);
    }
    return result;
}

/** Relative links of a markdown file that do not resolve to a file or to a heading. */
function linkProblems(text, root, relativePath) {
    const problems = [];
    const here = path.join(root, relativePath);
    for (const line of proseLines(text)) {
        for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
            const target = match[1];
            if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
            const [file, fragment] = target.split('#');
            const resolved = file === '' ? here : path.resolve(path.dirname(here), file);
            if (!fs.existsSync(resolved)) { problems.push(`${relativePath}: ${target} (no such file)`); continue; }
            if (fragment !== undefined && fs.statSync(resolved).isFile() && resolved.endsWith('.md')) {
                if (!anchors(fs.readFileSync(resolved, 'utf8')).has(fragment)) problems.push(`${relativePath}: ${target} (no such heading)`);
            }
        }
    }
    return problems;
}

module.exports = { splitHalves, proseLines, tableAfter, codeBlocks, headings, anchors, linkProblems };
