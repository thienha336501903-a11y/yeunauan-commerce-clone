// Public catalog of courses open for sale on the website (Owner 19/11, "Duyệt code WEB").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { openCatalog } from '../api/config.js';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const row = (slug, extra = {}) => ({
  id: slug, slug, title: `Khóa ${slug}`, price: '500.000đ', active: true, is_published: false, delivery_mode: 'v5',
  description: '', image_url: '', sort_order: null, raw_data: { bankAccount: '0123456789', bankOwner: 'X', qrImageUrl: 'https://qr' }, ...extra
});

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('WC-1 only active, not paused, ready courses; paused/inactive/unready V4/Telegram without chat are left out', async () => {
  await withEnv({ PUBLIC_CHECKOUT_DISABLED: '0' }, async () => {
    const out = await openCatalog([
      row('open'),
      row('paused', { raw_data: { salePaused: true } }),
      row('off', { active: false }),
      row('v4-draft', { delivery_mode: 'v4' }),
      row('v4-presale', { delivery_mode: 'v4', raw_data: { v4SellBeforePublishAcknowledged: true } }),
      row('tg-nochat', { delivery_mode: 'telegram' }),
      row('tg-ok', { delivery_mode: 'telegram', telegram_chat_id: '-100123' }),
      row('Bad Slug')
    ]);
    assert.deepEqual(out.map((c) => c.slug), ['open', 'tg-ok', 'v4-presale'].sort((a, b) => `Khóa ${a}`.localeCompare(`Khóa ${b}`, 'vi')));
  });
});

test('WC-2 the global switch closes every course (same rule as the course page)', async () => {
  await withEnv({ PUBLIC_CHECKOUT_DISABLED: '1' }, async () => {
    assert.deepEqual(await openCatalog([row('open')]), []);
  });
});

test('WC-3 public fields only: no bank account, QR, Telegram chat or LMS link; text plain and short; image https only', async () => {
  await withEnv({ PUBLIC_CHECKOUT_DISABLED: '0' }, async () => {
    const [c] = await openCatalog([row('a', {
      title: '<b>Bánh</b>   mì', description: `<p>${'x'.repeat(300)}</p>`, image_url: 'http://insecure/img.jpg', telegram_chat_id: '-100'
    })]);
    assert.deepEqual(Object.keys(c).sort(), ['imageUrl', 'price', 'slug', 'summary', 'title']);
    assert.equal(c.title, 'Bánh mì');
    assert.equal(c.summary.length, 160);
    assert.equal(c.imageUrl, '');
    assert.doesNotMatch(JSON.stringify(c), /0123456789|qr|-100/);
    const [d] = await openCatalog([row('b', { image_url: 'https://cdn/x.jpg' })]);
    assert.equal(d.imageUrl, 'https://cdn/x.jpg');
  });
});

test('WC-4 order: sort_order first (empty last), then title', async () => {
  await withEnv({ PUBLIC_CHECKOUT_DISABLED: '0' }, async () => {
    const out = await openCatalog([row('c', { title: 'C' }), row('b', { title: 'B', sort_order: 2 }), row('a', { title: 'A' }), row('z', { title: 'Z', sort_order: 1 })]);
    assert.deepEqual(out.map((c) => c.slug), ['z', 'b', 'a', 'c']);
  });
});

test('WC-5 a course blocked by the shared storefront rule (e.g. V5 not ready) is not listed', async () => {
  const out = await openCatalog([row('ready'), row('blocked')], async (c) => (c.slug === 'blocked' ? { error: 'x' } : null));
  assert.deepEqual(out.map((c) => c.slug), ['ready']);
  const failing = await openCatalog([row('ready'), row('db-error')], async (c) => { if (c.slug === 'db-error') throw new Error('db'); return null; });
  assert.deepEqual(failing.map((c) => c.slug), ['ready']); // one failing lookup drops only that course
});

test('WC-6 wiring: catalog endpoint, shop root goes to the list, list links go through course-gate, Admin copy label', () => {
  const config = read('api/config.js');
  assert.match(config, /req\.query\?\.catalog \|\| ''\) === '1'/);
  assert.match(config, /const blocked = await storefrontBlock\(course\)/);
  assert.match(read('index.html'), /location\.replace\('\/khoa-hoc\.html'\)/);
  const page = read('khoa-hoc.html');
  assert.match(page, /\/api\/config\?catalog=1/);
  assert.match(page, /'\/\?course=' \+ encodeURIComponent\(c\.slug\)/);
  assert.doesNotMatch(page, /innerHTML/);
  assert.match(read('admin.html'), /Sao chép link đăng ký/);
});
