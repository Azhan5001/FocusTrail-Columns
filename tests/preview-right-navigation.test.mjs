import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../extension.js', import.meta.url), 'utf8');

test('Right Arrow skips preview for a focused file and enters an existing child column', () => {
  assert.match(source, /if \(row\._folderBrowserIsDirectory\)\s*this\._openFocusedDirectoryAndEnter\(row\);\s*else\s*this\._focusNextOpenColumn\(depth\);/s);
});
