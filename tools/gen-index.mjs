// Copyright 2026 by Moshix
/**
 * Regenerate the module list inside index.html.
 *
 * The page rewrites every module URL with a per-load token so the browser
 * cannot serve a stale copy. An import map can only do that for module URLs it
 * lists by name, so the list has to be complete -- hence generating it from
 * what is actually on disk rather than maintaining it by hand.
 *
 * Usage: node tools/gen-index.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const START = '    /* MODULES:BEGIN */';
const END = '    /* MODULES:END */';

/** @param {string} dir @returns {string[]} */
export function listModules(dir = join(ROOT, 'src')) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listModules(full));
    else if (entry.endsWith('.js')) out.push(relative(join(ROOT, 'src'), full));
  }
  return out.sort();
}

function main() {
  const path = join(ROOT, 'index.html');
  const html = readFileSync(path, 'utf8');
  const begin = html.indexOf(START);
  const finish = html.indexOf(END);
  if (begin < 0 || finish < 0) throw new Error('index.html is missing the MODULES markers');

  const list = listModules()
    .map((p) => `      '${p.split('\\').join('/')}',`)
    .join('\n');
  const next = `${html.slice(0, begin + START.length)}\n${list}\n${html.slice(finish)}`;
  writeFileSync(path, next);
  console.log(`index.html: ${listModules().length} modules listed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
