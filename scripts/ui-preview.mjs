#!/usr/bin/env node
// Local UI preview of the commerce Admin pages with fake data. Runs the real /api handlers against an
// in-memory fake Supabase (PostgREST over fetch). Nothing leaves this machine: Supabase, Telegram,
// Cloudinary and LMS calls are answered locally. Usage: node scripts/ui-preview.mjs [port]  (password: preview-local)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || Number(process.argv[2]) || 4317;
Object.assign(process.env, {
  SUPABASE_URL: 'http://fake-supabase.local', SUPABASE_SERVICE_ROLE_KEY: 'fake', ADMIN_PASSWORD: 'preview-local',
  LEGACY_HOST_ALLOWLIST: `localhost:${port},localhost,127.0.0.1:${port}`, LMS_PUBLIC_URL: 'https://fake-lms.local',
  PUBLIC_CHECKOUT_DISABLED: '0'
});

const now = Date.now();
const ago = h => new Date(now - h * 3600e3).toISOString();
const bill = n => `https://placehold.co/600x900/f3ece4/7a4a2f?text=Bill+${n}`;
const db = {
  courses: [
    { id: 'c1', slug: 'banh-mi-co-ban', title: 'Bánh mì Việt cơ bản', price: '350.000đ', delivery_mode: 'v5', active: true, is_published: true, sort_order: 1, created_at: ago(900), image_url: 'https://placehold.co/800x500/e9dccb/5b3a24?text=Banh+mi', description: 'Từ bột tới vỏ giòn ruột xốp.', raw_data: { bankName: 'VCB', bankAccount: '0123456789', accountName: 'NGUYEN VAN A', transferNote: 'banh-mi <gmail>' } },
    { id: 'c2', slug: 'croissant-pro', title: 'Croissant chuyên nghiệp', price: '890.000đ', delivery_mode: 'v5', active: true, is_published: true, sort_order: 2, created_at: ago(700), image_url: 'https://placehold.co/800x500/efe2d0/6b4226?text=Croissant', raw_data: { salePaused: true } },
    { id: 'c3', slug: 'banh-kem-telegram', title: 'Bánh kem qua Telegram', price: '490.000đ', delivery_mode: 'telegram', active: true, sort_order: 3, created_at: ago(500), telegram_chat_id: '-100555', telegram_chat_title: 'Nhóm Bánh kem K1', raw_data: {} },
    { id: 'c4', slug: 'mon-chay-v4', title: 'Món chay (V4)', price: '250.000đ', delivery_mode: 'v4', active: false, is_published: false, sort_order: 4, created_at: ago(1500), raw_data: {} },
    { id: 'c5', slug: 'nau-an-gia-dinh', title: 'Nấu ăn gia đình (LMS cũ)', price: '199.000đ', delivery_mode: 'lms', active: false, sort_order: 5, created_at: ago(3000), raw_data: {} }
  ],
  orders: [],
  site_config: [], tgcloner_sources: [], lms_v4_telegram_course_sources: [], student_enrollments: [], messenger_tickets: []
};
const people = ['lan.nguyen', 'minh.tran', 'hoa.le', 'tuan.pham', 'mai.vo', 'quang.do', 'thu.bui', 'khanh.ho', 'linh.dang', 'son.ngo', 'yen.phan', 'duc.vu'];
people.forEach((p, i) => {
  const course = db.courses[i % 3];
  const status = i < 5 ? 'Chờ duyệt' : i < 10 ? 'Đã duyệt' : 'Từ chối';
  const tg = course.delivery_mode === 'telegram';
  db.orders.push({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, created_at: ago(i * 7 + 1), updated_at: ago(i * 7), course_id: course.id, course_slug: course.slug, course_title: course.title,
    customer_email: tg ? null : `${p}@gmail.com`, telegram_claimed_username: tg ? p.replace('.', '_') : null, proof_image_url: bill(i + 1), status, delivery_mode: course.delivery_mode,
    sync_lms_status: tg ? 'SKIPPED_TELEGRAM' : status === 'Đã duyệt' ? 'SUCCESS' : 'PENDING', sync_portal_status: 'SKIPPED_V5',
    telegram_chat_id: tg ? '-100555' : null, telegram_invite_link: tg ? 'https://t.me/+preview' : null, telegram_join_status: tg ? (status === 'Đã duyệt' ? 'approved' : 'requested') : null,
    telegram_user_id: tg ? 9000 + i : null, telegram_username: tg ? p.replace('.', '_') : null, telegram_first_name: tg ? p.split('.')[0] : null,
    raw_data: { channel: ['website', 'facebook', 'manual'][i % 3], billName: `bill-${i + 1}.jpg` }
  });
});

function matches(r, key, raw) {
  const value = decodeURIComponent(raw);
  const [op, ...rest] = value.split('.');
  const arg = rest.join('.');
  const cell = r[key];
  if (op === 'eq') return String(cell) === arg;
  if (op === 'neq') return String(cell) !== arg;
  if (op === 'is') return arg === 'null' ? cell == null : String(cell) === arg;
  if (op === 'in') return arg.replace(/^\(|\)$/g, '').split(',').map(v => v.replace(/^"|"$/g, '')).includes(String(cell));
  if (op === 'ilike') return String(cell ?? '').toLowerCase() === arg.toLowerCase();
  return true;
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname !== 'fake-supabase.local') return json({ ok: false, error: 'preview: external call skipped' }, 503);
  if (u.pathname.includes('/rpc/')) return json([]);
  const table = u.pathname.split('/').pop();
  const rows = db[table] || (db[table] = []);
  const filters = [...u.searchParams].filter(([k]) => !['select', 'limit', 'order', 'offset'].includes(k));
  const method = (init.method || 'GET').toUpperCase();
  if (method === 'POST') {
    const body = JSON.parse(init.body || '[]');
    const list = (Array.isArray(body) ? body : [body]).map(r => ({ created_at: new Date().toISOString(), id: r.id || crypto.randomUUID(), ...r }));
    rows.push(...list);
    return json(list, 201);
  }
  const hit = rows.filter(r => filters.every(([k, v]) => matches(r, k, v)));
  if (method === 'PATCH') hit.forEach(r => Object.assign(r, JSON.parse(init.body)));
  if (method === 'DELETE') hit.forEach(r => rows.splice(rows.indexOf(r), 1));
  let out = hit.map(r => ({ ...r }));
  const order = u.searchParams.get('order');
  if (order) { const [col, dir] = order.split(',')[0].split('.'); out.sort((a, b) => (a[col] > b[col] ? 1 : -1) * (dir === 'desc' ? -1 : 1)); }
  if (u.searchParams.get('limit')) out = out.slice(0, Number(u.searchParams.get('limit')));
  const accept = String(new Headers(init.headers).get('accept') || '');
  if (accept.includes('vnd.pgrst.object')) return out.length ? json(out[0]) : json({ message: 'no rows' }, 406);
  if (String(new Headers(init.headers).get('prefer') || '').includes('count=exact')) return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json', 'content-range': `0-${out.length}/${out.length}` } });
  return json(out);
};
void realFetch;

const handlers = {};
async function handler(name) {
  if (!(name in handlers)) {
    const file = path.join(root, 'api', `${name}.js`);
    handlers[name] = fs.existsSync(file) ? (await import(`file://${file.replace(/\\/g, '/')}`)).default : null;
  }
  return handlers[name];
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith('/api/')) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const name = url.pathname.slice(5).replace(/\/$/, '');
    if (name === 'messenger-tickets') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ tickets: [] })); }
    const fn = await handler(name);
    if (!fn) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"preview: no handler"}'); }
    // x-forwarded-proto: the same-origin check compares Origin with the real scheme
    const vreq = { method: req.method, url: req.url, headers: { ...req.headers, 'x-forwarded-proto': 'http' }, query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : {} };
    const vres = {
      statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
      json(d) { res.writeHead(this.statusCode, { ...this.headers, 'content-type': 'application/json' }); res.end(JSON.stringify(d)); return this; },
      send(d) { res.writeHead(this.statusCode, this.headers); res.end(typeof d === 'string' ? d : JSON.stringify(d)); return this; },
      end(d) { res.writeHead(this.statusCode, this.headers); res.end(d); return this; }
    };
    try { await fn(vreq, vres); } catch (e) { console.error(name, e); if (!res.headersSent) { res.writeHead(500); res.end(String(e.message)); } }
    return;
  }
  const file = url.pathname === '/' ? 'admin.html' : url.pathname.replace(/^\//, '');
  const full = path.join(root, file);
  if (!/^[A-Za-z0-9._/-]+$/.test(file) || !full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[path.extname(full)] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  fs.createReadStream(full).pipe(res);
}).listen(port, () => console.log(`UI preview: http://localhost:${port}/admin.html  http://localhost:${port}/orders.html  (password: preview-local)`));
