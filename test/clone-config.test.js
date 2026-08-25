import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneConfig } from '../utils/clone-config.js';

test('Clone Factory defaults preserve System B Commerce behavior', () => {
  const config = cloneConfig({});
  assert.equal(config.systemId, 'system-b');
  assert.equal(config.commercePublicUrl, 'https://yeubep.shop');
  assert.equal(config.lmsPublicUrl, 'https://hoc.yeubep.shop');
  assert.equal(config.v4PublicUrl, 'https://v4.daubepnho.store');
  assert.equal(config.telegramClonerUrl, 'https://reader.yeubep.shop');
  assert.equal(config.legacyPortalPublicUrl, 'https://yeunauan.live');
});

test('Clone Factory accepts an isolated System C topology', () => {
  const config = cloneConfig({
    SYSTEM_ID: 'system-c',
    COMMERCE_PUBLIC_URL: 'shop.example.com',
    LMS_PUBLIC_URL: 'learn.example.com',
    V4_PUBLIC_URL: 'player.example.com',
    TELEGRAM_CLONER_URL: 'reader.example.com',
    LEGACY_PORTAL_PUBLIC_URL: 'legacy.example.com'
  });
  assert.equal(config.systemId, 'system-c');
  assert.equal(config.commercePublicUrl, 'https://shop.example.com');
  assert.equal(config.lmsPublicUrl, 'https://learn.example.com');
  assert.equal(config.v4PublicUrl, 'https://player.example.com');
  assert.equal(config.telegramClonerUrl, 'https://reader.example.com');
  assert.equal(config.legacyPortalPublicUrl, 'https://legacy.example.com');
});

test('Clone Factory rejects non-HTTPS service origins', () => {
  assert.throws(() => cloneConfig({ LMS_PUBLIC_URL: 'http://learn.example.com' }), /clone_config_invalid_https_origin/);
});
