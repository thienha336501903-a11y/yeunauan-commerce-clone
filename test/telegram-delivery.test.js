// Telegram course delivery: join request -> Admin approval (bot or orders.html) -> member; decline, revoke, new invite.
// Supabase (PostgREST) and the Telegram Bot API are faked behind fetch; the real handlers run unchanged.
import './telegram-env.fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import webhook from '../api/telegram-webhook.js';
import ordersHandler from '../api/orders.js';
import { findOpenTelegramOrder } from '../utils/bill-order.js';
import { telegramBotAdminRights } from '../utils/telegram.js';

const CHAT = '-100555';
const ORDER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LINK = 'https://t.me/+order-link-1';
let db;
let tgCalls;
let tgFail;
let memberStatus;

function reset(order = {}) {
  db = {
    orders: [{
      id: ORDER, course_id: 'c1', course_slug: 'tg-khoa', course_title: 'Khoá TG', delivery_mode: 'telegram', status: 'Chờ duyệt',
      telegram_chat_id: CHAT, telegram_invite_link: LINK, telegram_join_status: 'invite_ready', telegram_user_id: null,
      telegram_claimed_username: 'hocvien', proof_image_url: 'https://res.cloudinary.com/x/bill.png', updated_at: '2026-11-23T08:00:00.000Z', ...order
    }],
    courses: [{ id: 'c1', telegram_invite_ttl_hours: 48 }],
    site_config: []
  };
  tgCalls = [];
  tgFail = {};
  memberStatus = 'left';
}
const row = () => db.orders[0];
const methods = () => tgCalls.map(c => c.method);

function matches(r, key, raw) {
  const value = decodeURIComponent(raw);
  const [op, ...rest] = value.split('.');
  const arg = rest.join('.');
  const cell = r[key];
  if (op === 'eq') return String(cell) === arg;
  if (op === 'neq') return String(cell) !== arg;
  if (op === 'is') return arg === 'null' ? cell == null : String(cell) === arg;
  if (op === 'in') return arg.replace(/^\(|\)$/g, '').split(',').map(v => v.replace(/^"|"$/g, '')).includes(String(cell));
  if (op === 'ilike') {
    const re = arg.replace(/\\(.)|([%*_])|([.+?^${}()|[\]\\])/g, (m, esc, wild, meta) => esc ? esc.replace(/[.+?^${}()|[\]\\*]/g, '\\$&') : wild ? (wild === '_' ? '.' : '.*') : '\\' + meta);
    return new RegExp(`^${re}$`, 'i').test(String(cell ?? ''));
  }
  throw new Error('fake PostgREST: unsupported filter ' + value);
}

async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'api.telegram.org') {
    const method = u.pathname.split('/').pop();
    const payload = JSON.parse(init.body || '{}');
    tgCalls.push({ method, payload });
    if (tgFail[method]) return json({ ok: false, description: tgFail[method] }, 400);
    if (method === 'getChatMember') return memberStatus === null ? json({ ok: false, description: 'Bad Gateway' }, 502) : json({ ok: true, result: { status: memberStatus } });
    if (method === 'createChatInviteLink') return json({ ok: true, result: { invite_link: 'https://t.me/+new-link', name: payload.name } });
    return json({ ok: true, result: true });
  }
  if (u.pathname.includes('/rpc/')) return json([]); // agency routing: legacy host, no tenant
  const table = u.pathname.split('/').pop();
  const rows = db[table];
  if (!rows) throw new Error('fake PostgREST: unknown table ' + table);
  const filters = [...u.searchParams].filter(([k]) => !['select', 'limit', 'order'].includes(k));
  const hit = rows.filter(r => filters.every(([k, v]) => matches(r, k, v)));
  const method = (init.method || 'GET').toUpperCase();
  let out = hit;
  if (method === 'PATCH') {
    const patch = JSON.parse(init.body);
    for (const r of hit) Object.assign(r, patch);
  } else if (method !== 'GET') throw new Error('fake PostgREST: ' + method);
  const limit = Number(u.searchParams.get('limit')) || out.length;
  out = out.slice(0, limit).map(r => ({ ...r }));
  const accept = String(new Headers(init.headers).get('accept') || '');
  if (accept.includes('vnd.pgrst.object')) return out.length === 1 ? json(out[0]) : json({ message: 'not one row' }, 406);
  return json(out);
}
globalThis.fetch = fakeFetch;

function fakeRes() {
  return { statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(d) { this.body = d; return this; }, end() { return this; } };
}
async function hook(update, secret = 'tg-secret') {
  const res = fakeRes();
  await webhook({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: update }, res);
  return res;
}
const joinUpdate = (userId, updateId = 1, link = LINK) => ({ update_id: updateId, chat_join_request: { chat: { id: Number(CHAT) }, from: { id: userId, first_name: 'Hoc', username: 'hocvien' }, invite_link: { invite_link: link } } });
const button = (action, from = 777) => ({ update_id: 99, callback_query: { id: 'cb1', from: { id: from }, data: `${action}:${ORDER}` } });

async function put(body) {
  process.env.ADMIN_PASSWORD = 'pw';
  process.env.LEGACY_HOST_ALLOWLIST = 'legacy.example.test';
  const res = fakeRes();
  try { await ordersHandler({ method: 'PUT', headers: { host: 'legacy.example.test', 'x-admin-password': 'pw' }, body, query: {} }, res); } finally { delete process.env.ADMIN_PASSWORD; delete process.env.LEGACY_HOST_ALLOWLIST; }
  return res;
}

test('TG-1 webhook needs the secret token', async () => {
  reset();
  assert.equal((await hook(joinUpdate(5), 'wrong')).statusCode, 401);
  assert.equal(row().telegram_user_id, null);
});

test('TG-2 first requester binds the order, Admin gets DUYỆT/TỪ CHỐI buttons, nobody is let in yet', async () => {
  reset();
  assert.equal((await hook(joinUpdate(5))).statusCode, 200);
  assert.equal(row().telegram_join_status, 'requested');
  assert.equal(String(row().telegram_user_id), '5');
  assert.equal(row().status, 'Chờ duyệt');
  assert.deepEqual(methods(), ['sendMessage']);
  assert.equal(tgCalls[0].payload.chat_id, '-100900');
  assert.deepEqual(tgCalls[0].payload.reply_markup.inline_keyboard[0].map(b => b.callback_data), [`tgapprove:${ORDER}`, `tgdecline:${ORDER}`]);
});

test('TG-3 a second account on the same link is declined; a rejected order link lets nobody in', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  await hook(joinUpdate(6, 2));
  assert.deepEqual(methods(), ['declineChatJoinRequest']);
  assert.equal(tgCalls[0].payload.user_id, 6);
  assert.equal(String(row().telegram_user_id), '5');

  reset({ status: 'Từ chối', telegram_join_status: 'declined' });
  await hook(joinUpdate(8, 3));
  assert.deepEqual(methods(), ['declineChatJoinRequest']);
  assert.equal(row().telegram_user_id, null);
});

test('TG-4 only a listed Admin can press the buttons', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  await hook(button('tgapprove', 1234));
  assert.deepEqual(methods(), ['answerCallbackQuery']);
  assert.equal(row().status, 'Chờ duyệt');
});

test('TG-5 DUYỆT: approve join, order approved, invite link revoked; a resent button does nothing twice', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  await hook(button('tgapprove'));
  assert.deepEqual(methods(), ['approveChatJoinRequest', 'revokeChatInviteLink', 'answerCallbackQuery']);
  assert.equal(row().status, 'Đã duyệt');
  assert.equal(row().telegram_join_status, 'approved');
  assert.equal(row().sync_lms_status, 'SKIPPED_TELEGRAM');
  tgCalls = [];
  await hook(button('tgapprove'));
  assert.deepEqual(methods(), ['answerCallbackQuery']);
});

test('TG-6 two approvals at the same time: Telegram is asked once', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  const results = await Promise.all([put({ id: ORDER, status: 'Đã duyệt' }), hook(button('tgapprove'))]);
  assert.equal(methods().filter(m => m === 'approveChatJoinRequest').length, 1);
  assert.equal(row().status, 'Đã duyệt');
  assert.ok(results.some(r => r.statusCode === 200));
});

test('TG-7 request gone at approval: order stays waiting, customer asks again, Admin approves', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  tgFail.approveChatJoinRequest = 'Bad Request: HIDE_REQUESTER_MISSING';
  const res = await put({ id: ORDER, status: 'Đã duyệt' });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'telegram_request_gone');
  assert.equal(row().status, 'Chờ duyệt');
  assert.equal(row().telegram_join_status, 'approve_failed');

  delete tgFail.approveChatJoinRequest;
  tgCalls = [];
  await hook(joinUpdate(5, 7));
  assert.equal(row().telegram_join_status, 'requested');
  assert.deepEqual(methods(), ['sendMessage']);
  assert.equal((await put({ id: ORDER, status: 'Đã duyệt' })).statusCode, 200);
  assert.equal(row().status, 'Đã duyệt');
});

test('TG-8 already a member counts as approved (no duplicate access, no error)', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  tgFail.approveChatJoinRequest = 'Bad Request: USER_ALREADY_PARTICIPANT';
  assert.equal((await put({ id: ORDER, status: 'Đã duyệt' })).statusCode, 200);
  assert.equal(row().telegram_join_status, 'approved');
});

test('TG-9 Admin web: approve without a join request is refused; "Chờ duyệt" is not a Telegram transition', async () => {
  reset();
  const res = await put({ id: ORDER, status: 'Đã duyệt' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'telegram_no_request');
  assert.deepEqual(methods(), []);
  reset({ status: 'Đã duyệt', telegram_user_id: 5, telegram_join_status: 'approved' });
  assert.equal((await put({ id: ORDER, status: 'Chờ duyệt' })).statusCode, 409);
  assert.equal(row().status, 'Đã duyệt');
});

test('TG-10 Từ chối a waiting order: pending request declined, link revoked, order rejected', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  assert.equal((await put({ id: ORDER, status: 'Từ chối' })).statusCode, 200);
  assert.deepEqual(methods(), ['declineChatJoinRequest', 'revokeChatInviteLink']);
  assert.equal(row().status, 'Từ chối');
  assert.equal(row().telegram_join_status, 'declined');
});

test('TG-11 revoke an approved order: member removed (ban + unban), order rejected; Telegram failure changes nothing', async () => {
  reset({ status: 'Đã duyệt', telegram_user_id: 5, telegram_join_status: 'approved' });
  tgFail.banChatMember = 'Bad Request: not enough rights to restrict/unrestrict chat member';
  memberStatus = 'member';
  const failed = await put({ id: ORDER, status: 'Từ chối' });
  assert.equal(failed.statusCode, 409);
  assert.equal(failed.body.code, 'telegram_still_member');
  assert.match(failed.body.error, /Ban users/);
  assert.equal(row().status, 'Đã duyệt');
  assert.equal(row().telegram_join_status, 'approved');

  delete tgFail.banChatMember;
  memberStatus = 'left'; // what Telegram reports after ban + unban
  tgCalls = [];
  assert.equal((await put({ id: ORDER, status: 'Từ chối' })).statusCode, 200);
  assert.deepEqual(methods(), ['banChatMember', 'unbanChatMember', 'getChatMember']);
  assert.equal(tgCalls[1].payload.only_if_banned, true);
  assert.equal(row().status, 'Từ chối');
  assert.equal(row().telegram_join_status, 'revoked');
});

test('TG-12 new invite link: old link revoked, new link with course TTL, failed requester unbound', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'approve_failed' });
  const res = await put({ id: ORDER, action: 'telegram_reissue_invite' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(methods(), ['getChatMember', 'revokeChatInviteLink', 'createChatInviteLink']); // not inside -> safe to unbind
  assert.equal(tgCalls[2].payload.creates_join_request, true);
  const ttl = tgCalls[2].payload.expire_date - Math.floor(Date.now() / 1000);
  assert.ok(ttl > 47 * 3600 && ttl <= 48 * 3600);
  assert.equal(row().telegram_invite_link, 'https://t.me/+new-link');
  assert.equal(row().telegram_join_status, 'invite_ready');
  assert.equal(row().telegram_user_id, null);

  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  assert.equal((await put({ id: ORDER, action: 'telegram_reissue_invite' })).statusCode, 409);
});

test('TG-13 a half-done approval (crash after Telegram) is finished on retry after 2 minutes, not before', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'approving', updated_at: new Date().toISOString() });
  assert.equal((await put({ id: ORDER, status: 'Đã duyệt' })).statusCode, 409);
  reset({ telegram_user_id: 5, telegram_join_status: 'approving', updated_at: '2026-01-01T00:00:00.000Z' });
  tgFail.approveChatJoinRequest = 'Bad Request: HIDE_REQUESTER_MISSING'; // what Telegram says for an approved request
  memberStatus = 'member';
  assert.equal((await put({ id: ORDER, status: 'Đã duyệt' })).statusCode, 200);
  assert.equal(row().status, 'Đã duyệt');
  assert.equal(row().telegram_join_status, 'approved');
});

test('TG-16 customer already inside after a half-done approval: decline and new link are refused, approve records it', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'approve_failed' });
  memberStatus = 'member';
  const declined = await put({ id: ORDER, status: 'Từ chối' });
  assert.equal(declined.statusCode, 409);
  assert.equal(declined.body.code, 'telegram_already_member');
  assert.equal((await put({ id: ORDER, action: 'telegram_reissue_invite' })).body.code, 'telegram_already_member');
  assert.equal(row().status, 'Chờ duyệt');
  assert.ok(!methods().includes('declineChatJoinRequest') && !methods().includes('createChatInviteLink'));
  tgFail.approveChatJoinRequest = 'Bad Request: HIDE_REQUESTER_MISSING';
  assert.equal((await put({ id: ORDER, status: 'Đã duyệt' })).statusCode, 200);
  assert.equal(row().status, 'Đã duyệt');
});

test('TG-20 unknown membership blocks a reject after a half-done approval; ban ok + unban failed is unbanned again', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'approve_failed' });
  memberStatus = null;
  assert.equal((await put({ id: ORDER, status: 'Từ chối' })).body.code, 'telegram_already_member');
  assert.equal(row().status, 'Chờ duyệt');

  reset({ status: 'Đã duyệt', telegram_user_id: 5, telegram_join_status: 'approved' });
  tgFail.unbanChatMember = 'Internal Server Error';
  memberStatus = 'kicked';
  assert.equal((await put({ id: ORDER, status: 'Từ chối' })).statusCode, 200);
  assert.deepEqual(methods(), ['banChatMember', 'unbanChatMember', 'getChatMember', 'unbanChatMember']);
  assert.equal(row().telegram_join_status, 'revoked');
});

test('TG-17 transient Telegram error (429): order kept waiting and the Admin can press Duyệt again', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  tgFail.approveChatJoinRequest = 'Too Many Requests: retry after 5';
  const first = await put({ id: ORDER, status: 'Đã duyệt' });
  assert.equal(first.statusCode, 502);
  assert.equal(first.body.code, 'telegram_api_error');
  assert.equal(row().telegram_join_status, 'approve_failed');
  delete tgFail.approveChatJoinRequest;
  assert.equal((await put({ id: ORDER, status: 'Đã duyệt' })).statusCode, 200);
  assert.equal(row().status, 'Đã duyệt');
});

test('TG-18 channel: bot cannot ban, Admin removed the member by hand -> revoke completes', async () => {
  reset({ status: 'Đã duyệt', telegram_user_id: 5, telegram_join_status: 'approved' });
  tgFail.banChatMember = 'Bad Request: not enough rights';
  memberStatus = 'member';
  assert.equal((await put({ id: ORDER, status: 'Từ chối' })).statusCode, 409);
  assert.equal(row().status, 'Đã duyệt');
  memberStatus = 'left';
  assert.equal((await put({ id: ORDER, status: 'Từ chối' })).statusCode, 200);
  assert.equal(row().telegram_join_status, 'revoked');
});

test('TG-19 status change mixed with a note is refused (no silent drop); missing Admin chat is written on the order', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  const res = await put({ id: ORDER, status: 'Đã duyệt', note: 'x' });
  assert.equal(res.statusCode, 400);
  assert.equal(row().status, 'Chờ duyệt');
  assert.deepEqual(methods(), []);

  reset();
  const saved = process.env.TELEGRAM_ADMIN_CHAT_ID;
  process.env.TELEGRAM_ADMIN_CHAT_ID = '';
  try { await hook(joinUpdate(5, 11)); } finally { process.env.TELEGRAM_ADMIN_CHAT_ID = saved; }
  assert.equal(row().telegram_join_status, 'requested');
  assert.match(row().sync_error, /orders\.html/);
});

test('TG-14 duplicate guard at register: same nick + course, case-insensitive, LIKE wildcards literal', async () => {
  reset({ telegram_claimed_username: 'Hoc_Vien' });
  assert.equal((await findOpenTelegramOrder(globalDb(), 'hoc_vien', 'tg-khoa'))?.id, ORDER);
  assert.equal(await findOpenTelegramOrder(globalDb(), 'hocxvien', 'tg-khoa'), null);
  assert.equal(await findOpenTelegramOrder(globalDb(), '**', 'tg-khoa'), null); // PostgREST * is literal too
  assert.equal(await findOpenTelegramOrder(globalDb(), 'h*', 'tg-khoa'), null);
  row().telegram_claimed_username = 'a*b'; // a nick with * still matches itself exactly
  assert.equal((await findOpenTelegramOrder(globalDb(), 'A*B', 'tg-khoa'))?.id, ORDER);
  assert.equal(await findOpenTelegramOrder(globalDb(), 'axb', 'tg-khoa'), null);
  assert.equal(await findOpenTelegramOrder(globalDb(), 'hoc_vien', 'khoa-khac'), null);
  row().status = 'Từ chối';
  assert.equal(await findOpenTelegramOrder(globalDb(), 'hoc_vien', 'tg-khoa'), null);
});
async function importSupabase() { return (await import('../utils/supabase.js')).supabase; }
let supa;
function globalDb() { return supa; }
test.before(async () => { supa = await importSupabase(); });

test('TG-15 wiring: register refuses a duplicate nick before upload; groups and channels get "ban users"; Admin page shows Telegram info', () => {
  const bill = fs.readFileSync(new URL('../utils/bill-order.js', import.meta.url), 'utf8');
  assert.ok(bill.indexOf('findOpenTelegramOrder(supabase, cleanTelegramNick, courseSlug)') < bill.indexOf('cloudinary.uploader.upload('));
  assert.equal(telegramBotAdminRights().can_restrict_members, true);
  assert.equal(telegramBotAdminRights({ restrict: false }).can_restrict_members, false);
  assert.equal(telegramBotAdminRights().can_invite_users, true);
  const page = fs.readFileSync(new URL('../orders.html', import.meta.url), 'utf8');
  assert.equal((page.match(/\$\{telegramInfoHtml\(order\)\}/g) || []).length, 2);
  assert.match(page, /action: "telegram_reissue_invite"/);
});

test('TG-21 setup: a rate-limited default-rights call does not block setWebhook; a setWebhook failure names the step', async () => {
  const { default: setup } = await import('../api/telegram-setup.js');
  const run = async () => {
    process.env.ADMIN_PASSWORD = 'pw';
    const res = fakeRes();
    try { await setup({ method: 'POST', headers: { host: 'shop.example.test', 'x-admin-password': 'pw' }, body: {} }, res); } finally { delete process.env.ADMIN_PASSWORD; }
    return res;
  };
  reset();
  tgFail.setMyDefaultAdministratorRights = 'Too Many Requests: retry after 32';
  let res = await run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(methods(), ['getMe', 'setMyDefaultAdministratorRights', 'setMyDefaultAdministratorRights', 'setWebhook']);
  assert.equal(tgCalls[3].payload.url, 'https://shop.example.test/api/telegram-webhook');
  assert.equal(tgCalls[3].payload.secret_token, 'tg-secret');
  assert.equal(res.body.warnings.length, 2);
  assert.deepEqual(tgCalls.slice(1, 3).map(c => c.payload.for_channels), [false, true]);
  assert.equal(tgCalls[2].payload.rights.can_restrict_members, true);

  reset();
  tgFail.setWebhook = 'Too Many Requests: retry after 5';
  res = await run();
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.step, 'setWebhook');
  assert.match(res.body.error, /retry after 5/);
});

// Admin notice buttons: after a confirmed decision the notice keeps its text and shows one display-only status button.
const MSG = { message_id: 42, chat: { id: 777 } };
const pressOn = (action, from = 777) => ({ update_id: 98, callback_query: { id: 'cb2', from: { id: from }, data: `${action}:${ORDER}`, message: MSG } });
const edits = () => tgCalls.filter(c => c.method === 'editMessageReplyMarkup');
const shownButtons = call => call.payload.reply_markup.inline_keyboard.flat().map(b => [b.text, b.callback_data]);

test('TG-22 DUYỆT ok -> notice shows only ✅ ĐÃ DUYỆT THÀNH CÔNG (display button); pressing it or a resent DUYỆT never approves again', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  await hook(pressOn('tgapprove'));
  assert.deepEqual(methods(), ['approveChatJoinRequest', 'revokeChatInviteLink', 'answerCallbackQuery', 'editMessageReplyMarkup']);
  assert.equal(edits()[0].payload.chat_id, 777);
  assert.equal(edits()[0].payload.message_id, 42);
  assert.deepEqual(shownButtons(edits()[0]), [['✅ ĐÃ DUYỆT THÀNH CÔNG', `tgdone:${ORDER}`]]);
  assert.equal(edits()[0].payload.text, undefined); // message text (customer, order id, bill) is not touched
  const decidedAt = row().telegram_join_decided_at;

  for (const action of ['tgdone', 'tgapprove', 'tgdecline']) {
    tgCalls = [];
    await hook(pressOn(action));
    assert.ok(!methods().some(m => /approveChatJoinRequest|declineChatJoinRequest|banChatMember/.test(m)), action);
    assert.deepEqual(methods(), ['answerCallbackQuery', 'editMessageReplyMarkup'], action);
  }
  assert.equal(row().status, 'Đã duyệt');
  assert.equal(row().telegram_join_decided_at, decidedAt);
});

test('TG-23 TỪ CHỐI ok -> ❌ ĐÃ TỪ CHỐI; a failed approval keeps both buttons and shows no success', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  await hook(pressOn('tgdecline'));
  assert.equal(row().status, 'Từ chối');
  assert.deepEqual(shownButtons(edits()[0]), [['❌ ĐÃ TỪ CHỐI', `tgdone:${ORDER}`]]);

  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  tgFail.approveChatJoinRequest = 'Too Many Requests: retry after 5';
  await hook(pressOn('tgapprove'));
  assert.equal(edits().length, 0);
  assert.equal(row().status, 'Chờ duyệt');
  assert.equal(row().telegram_join_status, 'approve_failed');
  const ans = tgCalls.find(c => c.method === 'answerCallbackQuery').payload;
  assert.match(ans.text, /không duyệt được/);
  assert.doesNotMatch(ans.text, /Đã duyệt/);
});

test('TG-24 decided in orders.html or by another Admin: the old notice button only syncs its status; revoked shows ⛔', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  assert.equal((await put({ id: ORDER, status: 'Đã duyệt' })).statusCode, 200);
  tgCalls = [];
  await hook(pressOn('tgdecline', 777));
  assert.deepEqual(methods(), ['answerCallbackQuery', 'editMessageReplyMarkup']);
  assert.deepEqual(shownButtons(edits()[0]), [['✅ ĐÃ DUYỆT THÀNH CÔNG', `tgdone:${ORDER}`]]);
  assert.equal(row().status, 'Đã duyệt');

  reset({ status: 'Từ chối', telegram_user_id: 5, telegram_join_status: 'revoked' });
  await hook(pressOn('tgapprove'));
  assert.deepEqual(shownButtons(edits()[0]), [['⛔ ĐÃ THU HỒI QUYỀN', `tgdone:${ORDER}`]]);
  assert.equal(row().status, 'Từ chối');
});

test('TG-25 parallel presses from two Admins: Telegram approves once, both notices end on ✅; edit failure does not re-approve', async () => {
  process.env.TELEGRAM_ADMIN_USER_IDS = '777,888';
  try {
    reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
    await Promise.all([hook(pressOn('tgapprove', 777)), hook(pressOn('tgapprove', 888)), hook(pressOn('tgapprove', 777))]);
    assert.equal(methods().filter(m => m === 'approveChatJoinRequest').length, 1);
    assert.equal(row().status, 'Đã duyệt');
    assert.ok(edits().length >= 1);
    for (const e of edits()) assert.deepEqual(shownButtons(e), [['✅ ĐÃ DUYỆT THÀNH CÔNG', `tgdone:${ORDER}`]]);

    reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
    tgFail.editMessageReplyMarkup = 'Bad Request: message to edit not found';
    const res = await hook(pressOn('tgapprove'));
    assert.equal(res.statusCode, 200); // no 500: Telegram does not resend the press
    assert.equal(row().status, 'Đã duyệt');
    tgCalls = [];
    await hook(pressOn('tgapprove'));
    assert.equal(methods().filter(m => m === 'approveChatJoinRequest').length, 0);
  } finally { process.env.TELEGRAM_ADMIN_USER_IDS = '777'; }
});

test('TG-26 "Thu hồi quyền học" action: verified out before done, never success while the member is inside, history kept, no double revoke', async () => {
  const revoke = async () => {
    process.env.ADMIN_PASSWORD = 'pw'; process.env.LEGACY_HOST_ALLOWLIST = 'legacy.example.test';
    const res = fakeRes();
    try { await ordersHandler({ method: 'PUT', headers: { host: 'legacy.example.test', 'x-admin-password': 'pw' }, body: { id: ORDER, action: 'telegram_revoke' }, query: {} }, res); } finally { delete process.env.ADMIN_PASSWORD; delete process.env.LEGACY_HOST_ALLOWLIST; }
    return res;
  };
  reset({ status: 'Đã duyệt', telegram_user_id: 5, telegram_join_status: 'approved', telegram_join_decided_at: '2026-11-24T13:54:22.784Z', raw_data: { billName: 'b.png' } });
  // Ban "succeeded" but Telegram still lists the member: not done.
  memberStatus = 'member';
  let res = await revoke();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'telegram_still_member');
  assert.equal(row().status, 'Đã duyệt');
  // Telegram does not answer the member check: not done either.
  memberStatus = null;
  res = await revoke();
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /Chưa xác nhận/);
  assert.equal(res.body.code, 'telegram_member_unknown');
  assert.equal(row().status, 'Đã duyệt');
  // Channel: no ban right, Admin removed by hand, presses again -> re-checked, done.
  tgFail.banChatMember = 'Bad Request: not enough rights';
  memberStatus = 'left';
  res = await revoke();
  assert.equal(res.statusCode, 200);
  assert.equal(row().status, 'Từ chối');
  assert.equal(row().telegram_join_status, 'revoked');
  assert.equal(row().telegram_join_decided_at, '2026-11-24T13:54:22.784Z'); // approval time kept
  assert.equal(row().raw_data.billName, 'b.png');
  assert.deepEqual(row().raw_data.telegram_history.map(h => [h.action, h.by]), [['revoke_failed', 'admin_web'], ['revoke_failed', 'admin_web'], ['revoke', 'admin_web']]);
  assert.equal(row().raw_data.telegram_history[2].manual, true);
  // Pressing again: already revoked, Telegram not called.
  tgCalls = [];
  assert.equal((await revoke()).statusCode, 409);
  assert.deepEqual(methods(), []);
});

test('TG-27 approve / decline write who decided into the order history', async () => {
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  await hook(button('tgapprove'));
  assert.deepEqual(row().raw_data.telegram_history.map(h => [h.action, h.by]), [['approve', 'bot']]);
  reset({ telegram_user_id: 5, telegram_join_status: 'requested' });
  await put({ id: ORDER, status: 'Từ chối' });
  assert.deepEqual(row().raw_data.telegram_history.map(h => [h.action, h.by]), [['decline', 'admin_web']]);
});

test('TG-28 connect picker asks the ban right for channels too; if Telegram refuses it, the picker is resent without it', async () => {
  const { sendCourseChatPicker } = await import('../utils/telegram.js');
  const channelReq = call => call.payload.reply_markup.keyboard[1][0].request_chat;
  reset();
  await sendCourseChatPicker({ adminChatId: 777, course: { slug: 'k' }, requestId: 1000 });
  assert.deepEqual(methods(), ['sendMessage']);
  assert.equal(channelReq(tgCalls[0]).chat_is_channel, true);
  assert.equal(channelReq(tgCalls[0]).bot_administrator_rights.can_restrict_members, true);
  assert.equal(tgCalls[0].payload.reply_markup.keyboard[0][0].request_chat.bot_administrator_rights.can_restrict_members, true);

  reset();
  let first = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/sendMessage') && first) { first = false; tgCalls.push({ method: 'sendMessage', payload: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: false, description: 'Bad Request: invalid administrator rights' }), { status: 400 }); }
    return realFetch(url, init);
  };
  try { await sendCourseChatPicker({ adminChatId: 777, course: { slug: 'k' }, requestId: 1000 }); } finally { globalThis.fetch = realFetch; }
  assert.equal(tgCalls.length, 2);
  assert.equal(channelReq(tgCalls[1]).bot_administrator_rights.can_restrict_members, false);
  assert.equal(channelReq(tgCalls[1]).bot_administrator_rights.can_invite_users, true);
});
