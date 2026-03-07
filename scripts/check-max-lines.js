#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const targetDir = process.argv[2] || 'src';
const maxLinesArg = Number.parseInt(process.argv[3] || '300', 10);
const maxLines = Number.isFinite(maxLinesArg) && maxLinesArg > 0 ? maxLinesArg : 300;

const rootDir = path.resolve(process.cwd(), targetDir);

if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
  console.error(`Directory not found: ${rootDir}`);
  process.exit(1);
}

const violations = [];

walk(rootDir);

if (violations.length > 0) {
  console.error(`Found ${violations.length} files exceeding ${maxLines} lines:`);
  violations
    .sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file))
    .forEach((entry) => {
      console.error(`- ${entry.file}: ${entry.lines}`);
    });
  process.exit(1);
}

console.log(`All TypeScript files in ${targetDir} are within ${maxLines} lines.`);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach((entry) => {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(absolutePath);
      return;
    }

    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) {
      return;
    }

    const content = fs.readFileSync(absolutePath, 'utf8');
    const lines = content.split(/\r?\n/).length;
    if (lines > maxLines) {
      violations.push({
        file: path.relative(process.cwd(), absolutePath),
        lines,
      });
    }
  });
}
