import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicUrl } from '../utils/public-urls.js';

test('normalizes valid public origins', () => {
  assert.equal(normalizePublicUrl('https://shop.example.com/', 'URL'), 'https://shop.example.com');
});

test('rejects missing, unsafe or path-based public URLs', () => {
  assert.throws(() => normalizePublicUrl('', 'URL'), /Missing required/);
  assert.throws(() => normalizePublicUrl('http://shop.example.com', 'URL'), /must use https/);
  assert.throws(() => normalizePublicUrl('https://shop.example.com/path', 'URL'), /must not contain a path/);
});
