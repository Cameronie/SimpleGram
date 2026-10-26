// Guards for the page script's structure that separately built features can break.
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = process.env.SG_SCRIPT || path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'simplegram.js');

test('structure: no two top-level functions or bindings share a name (a later one silently replaces the first)', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const names = new Map();
  // Top level of the page script's wrapper: two-space indentation.
  const re = /^ {2}(?:async\s+)?(?:function\s*\*?\s*([A-Za-z0-9_$]+)\s*\(|(?:const|let|var|class)\s+([A-Za-z0-9_$]+)\b)/gm;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1] || m[2];
    const line = src.slice(0, m.index).split('\n').length;
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(line);
  }
  const dupes = [...names].filter(([, lines]) => lines.length > 1).map(([n, lines]) => `${n} (lines ${lines.join(', ')})`);
  assert.deepEqual(dupes, []);
});
