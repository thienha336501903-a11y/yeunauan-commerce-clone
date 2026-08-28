import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../api/register.js', import.meta.url), 'utf8');

test('registration cleans a newly uploaded Cloudinary bill if order insert fails', () => {
  assert.match(source, /async function cleanupUnpersistedBill/);
  assert.match(source, /cloudinary\.uploader\.destroy\(id, \{ resource_type: 'image', invalidate: true \}\)/);
  assert.match(source, /if \(insertError\) \{[\s\S]*await cleanupUnpersistedBill\(uploadResult\.public_id\);[\s\S]*throw insertError/);
});

test('Cloudinary cleanup failure never masks the original order persistence error', () => {
  assert.match(source, /REGISTER_BILL_CLEANUP_ERROR/);
  assert.doesNotMatch(source, /catch \(error\) \{[\s\S]*throw error;[\s\S]*REGISTER_BILL_CLEANUP_ERROR/);
});
