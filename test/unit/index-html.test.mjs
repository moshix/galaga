// Copyright 2026 by Moshix
/**
 * The cache-busting import map in index.html must list every module in src/.
 *
 * index.html mints a token per load and rewrites each module URL to carry it,
 * so the whole graph is refetched rather than served stale. An import map can
 * only do that for URLs it names, so a module missing from the list silently
 * loses its cache busting -- the page still works, the console is clean, and
 * yesterday's code runs. That is a genuinely horrible afternoon.
 *
 * index.html's own comment has always claimed a test enforced this. Until this
 * file, none did.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listModules } from '../../tools/gen-index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const START = '/* MODULES:BEGIN */';
const END = '/* MODULES:END */';

/** The paths index.html actually lists. @returns {string[]} */
function listedModules() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const begin = html.indexOf(START);
  const finish = html.indexOf(END);
  assert.ok(begin >= 0 && finish > begin, 'index.html is missing the MODULES markers');
  const block = html.slice(begin + START.length, finish);
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('index.html lists exactly the modules on disk', () => {
  const onDisk = listModules().map((p) => p.split('\\').join('/'));
  const listed = listedModules();

  const missing = onDisk.filter((p) => !listed.includes(p));
  const stale = listed.filter((p) => !onDisk.includes(p));

  assert.deepEqual(missing, [], 'run `node tools/gen-index.mjs` -- these are not listed');
  assert.deepEqual(stale, [], 'run `node tools/gen-index.mjs` -- these no longer exist');
});

test('the listed modules are sorted and unique', () => {
  const listed = listedModules();
  assert.deepEqual(listed, [...listed].sort(), 'gen-index.mjs emits them sorted');
  assert.equal(new Set(listed).size, listed.length, 'a duplicate would shadow itself in the map');
});

test('every listed module actually resolves', () => {
  for (const path of listedModules()) {
    assert.doesNotThrow(
      () => readFileSync(join(ROOT, 'src', path)),
      `index.html points at src/${path}, which cannot be read`,
    );
  }
});
