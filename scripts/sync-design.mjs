#!/usr/bin/env node
// Copies the shared Console design (design/console.*.html) into each Admin page between its markers.
// The Worker serves only root *.html, so the design is inlined; this script keeps one source.
// Usage: node scripts/sync-design.mjs        (write)
//        node scripts/sync-design.mjs --check (exit 1 if a page is out of date)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DESIGN_PAGES = ['admin.html', 'orders.html'];
const BLOCKS = { HEAD: 'design/console.head.html', SIDEBAR: 'design/console.sidebar.html' };

export function applyDesign(html, read = rel => fs.readFileSync(path.join(root, rel), 'utf8')) {
  let out = html;
  for (const [name, file] of Object.entries(BLOCKS)) {
    const re = new RegExp(`(<!-- YB:${name} -->)[\\s\\S]*?(<!-- /YB:${name} -->)`);
    if (!re.test(out)) throw new Error(`missing <!-- YB:${name} --> markers`);
    const body = read(file).replace(/\r\n/g, '\n').trim();
    out = out.replace(re, (_m, open, close) => `${open}\n${body}\n${close}`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const page of DESIGN_PAGES) {
    const file = path.join(root, page);
    const before = fs.readFileSync(file, 'utf8');
    const after = applyDesign(before.replace(/\r\n/g, '\n'));
    if (after === before.replace(/\r\n/g, '\n')) continue;
    stale += 1;
    if (check) console.error(`${page}: design out of date (run node scripts/sync-design.mjs)`);
    else { fs.writeFileSync(file, after); console.log(`${page}: design updated`); }
  }
  if (check && stale) process.exit(1);
  if (check) console.log('design in sync');
}
