#!/usr/bin/env node
'use strict';

// Removes dist/ so every build starts from nothing: tsc only writes files, it
// never deletes the output of a source file that no longer exists, and such an
// orphan would be tested and published as if it were part of the plugin.

const fs = require('node:fs');
const path = require('node:path');

fs.rmSync(path.resolve(__dirname, '..', 'dist'), { recursive: true, force: true });
