import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../api/orders.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../test-bill-cleanup.html', import.meta.url), 'utf8');

test('orphan bill cleanup is restricted to empty clone factory courses', () => {
  assert.match(source, /DELETE_CLONE_FACTORY_TEST_ORPHAN_BILL/);
  assert.match(source, /TEST_SLUG_PATTERN\.test\(courseSlug\)/);
  assert.match(source, /publicId\.startsWith\(expectedPrefix\)/);
  assert.match(source, /activeOrderCount/);
  assert.match(source, /khóa test vẫn còn order trong DB/);
});

test('orphan bill cleanup uses configured Cloudinary credentials and accepts not found', () => {
  assert.match(source, /CLOUDINARY_API_SECRET/);
  assert.match(source, /cloudinary\.uploader\.destroy\(publicId/);
  assert.match(source, /\['ok', 'not found'\]/);
  assert.match(page, /sessionStorage\.getItem\('admin_password'\)/);
  assert.match(page, /DELETE_CLONE_FACTORY_TEST_ORPHAN_BILL/);
});
