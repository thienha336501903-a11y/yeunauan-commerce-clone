// Admin Console design: one source (design/console.*.html) inlined into the Admin pages; the shell must not
// touch page logic (same element IDs and scripts as before, login still gates the content).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyDesign, DESIGN_PAGES } from '../scripts/sync-design.mjs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('CD-1 every Admin page carries the current design blocks (run scripts/sync-design.mjs after editing design/)', () => {
  for (const page of DESIGN_PAGES) assert.equal(applyDesign(read(page)), read(page), page);
});

test('CD-2 shell wiring: body class + page key, sidebar, topbar with menu button, wrappers closed after main', () => {
  for (const [page, key] of [['admin.html', 'courses'], ['orders.html', 'orders']]) {
    const html = read(page);
    assert.match(html, new RegExp(`<body class="yb [^"]*" data-page="${key}">`));
    assert.match(html, /<aside class="yb-sidebar" id="ybSidebar"/);
    assert.match(html, /<header class="yb-topbar">[\s\S]*id="ybMenuBtn"[\s\S]*<h1 class="yb-title">/);
    assert.match(html, /<\/main>\n    <\/div>\n    <\/div>\n/);
    assert.doesNotMatch(html, /family=Outfit/);
    assert.equal((html.match(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>\n  <!-- YB:HEAD -->/g) || []).length, 1); // config after the CDN script
  }
});

test('CD-3 the shell keeps page logic: login overlay, dashboard wrapper and key element IDs are unchanged', () => {
  for (const page of DESIGN_PAGES) {
    const html = read(page);
    for (const id of ['loginOverlay', 'loginForm', 'adminPasswordInput', 'dashboardContent', 'globalLoader']) assert.match(html, new RegExp(`id="${id}"`), `${page} #${id}`);
  }
  assert.match(read('admin.html'), /id="courseList"/);
  assert.match(read('orders.html'), /id="statsDashboard"/);
});

test('CD-4 sidebar script: logout clears only the Admin password key; LMS links only from https runtime config', () => {
  const side = read('design/console.sidebar.html');
  assert.match(side, /sessionStorage\.removeItem\('admin_password'\)/);
  assert.match(side, /if \(\/\^https:\\\/\\\/\/\.test\(base\)\)/);
  assert.doesNotMatch(side, /innerHTML/);
});

test('CD-5 two themes: variables per theme, theme set before paint with guarded storage, switch only toggles data-theme', () => {
  const head = read('design/console.head.html');
  assert.match(head, /:root \{[\s\S]*--p-500: 18 173 145;/); // Bạc hà
  assert.match(head, /:root\[data-theme="ember"\] \{[\s\S]*--p-500: 242 86 31;/); // Than & Cam
  assert.match(head, /try \{ t = localStorage\.getItem\('yb-theme'\) \|\| 'mint'; \} catch \(e\) \{\}/);
  assert.match(head, /:root\[data-theme="crystal"\] \{[\s\S]*--p-500: 59 111 235;/); // Pha lê
  assert.match(head, /t === 'ember' \|\| t === 'crystal' \? t : 'mint'/); // unknown stored value falls back to mint
  const side = read('design/console.sidebar.html');
  assert.equal((side.match(/data-theme-pick="(mint|ember|crystal)"/g) || []).length, 3);
  assert.match(side, /try \{ localStorage\.setItem\('yb-theme', b\.dataset\.themePick\); \} catch \(e\) \{\}/);
});
