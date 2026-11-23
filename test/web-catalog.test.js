// Website sales by each course's own link only (Owner 19/11, 2nd decision): no public course list anywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('WC-1 no public course list: no list page, no catalog endpoint, shop root goes to the LMS student portal', () => {
  assert.equal(fs.existsSync(new URL('../khoa-hoc.html', import.meta.url)), false);
  const config = read('api/config.js');
  assert.doesNotMatch(config, /catalog/i);
  assert.doesNotMatch(read('index.html'), /khoa-hoc/);
  assert.match(read('index.html'), /location\.replace\(new URL\('\/my-courses\.html',config\.lmsPublicUrl\)/);
});

test('WC-2 the course link sells only that course: page loads its own slug, sale rule checked in the backend', () => {
  const config = read('api/config.js');
  assert.match(config, /const blocked = await storefrontBlock\(course\)/);
  assert.match(config, /isSalePaused\(course\) \|\| isPublicCheckoutDisabled\(\)/);
  assert.match(read('index.html'), /fetch\(`\/api\/config\?course=\$\{encodeURIComponent\(course\)\}`/);
  assert.doesNotMatch(read('course-gate.html'), /khoa-hoc|catalog/);
});

test('WC-3 Admin copies the course registration link', () => {
  assert.match(read('admin.html'), /Sao chép link đăng ký/);
});

test('WC-4 course page serif font has Vietnamese stacked marks (DM Serif Display breaks "CHUYỂN", "TIỀN")', () => {
  const page = read('index.html');
  assert.doesNotMatch(page, /DM Serif Display|DM\+Serif/);
  assert.match(page, /family=Playfair\+Display/);
  assert.match(page, /font-family:"Playfair Display",Georgia,serif/);
});
