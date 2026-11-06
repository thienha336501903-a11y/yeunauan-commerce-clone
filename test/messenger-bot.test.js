// Messenger sales bot (H4): webhook signature, conversation, duplicate/concurrent events, approval notice, Admin XSS.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifySignature, downloadBill } from "../utils/messenger/meta.js";
import { step, emptyState, PAUSE_MS } from "../utils/messenger/bot.js";
import { notifyApprovedOrder } from "../utils/messenger/notify.js";
import { messengerWebhook, MessengerConversation, toEvent } from "../cloudflare/commerce-worker/src/messenger.js";
import worker from "../cloudflare/commerce-worker/src/index.js";

const SECRET = "test-app-secret";
const PSID = "1234567890123";
const COURSES = [{ slug: "khoa-test", title: "Khoá TEST", price: "100.000đ", bankName: "VCB", bankAccount: "0123", bankOwner: "A", transferNote: "TEST", qrImageUrl: "" }];
const sign = (body, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
const ctx = (now = 1_000_000) => ({ now, courses: COURSES, approveSla: "12 giờ" });

function fakeStorage() {
  const map = new Map();
  return {
    map,
    async get(k) { return map.has(k) ? structuredClone(map.get(k)) : undefined; },
    async put(k, v) { map.set(k, structuredClone(v)); }
  };
}

function fakeFetch() {
  const sent = [];
  const impl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://graph.facebook.com/")) {
      sent.push({ url: u, auth: init.headers?.Authorization, body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    }
    if (/^https:\/\/scontent\.[a-z0-9.-]*fbcdn\.net\//.test(u)) {
      const res = new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
      Object.defineProperty(res, "url", { value: u });
      return res;
    }
    throw new Error("unexpected fetch " + u);
  };
  return { sent, impl };
}

const msg = (mid, message) => ({ sender: { id: PSID }, recipient: { id: "999" }, timestamp: 1, message: { mid, ...message } });
const IMG = "https://scontent.xx.fbcdn.net/v/bill.jpg";

function conversation({ createBillOrder, fetchImpl, env = {} } = {}) {
  const state = { storage: fakeStorage() };
  const calls = [];
  const convo = new MessengerConversation(state, { META_PAGE_ACCESS_TOKEN: "page-token", META_APP_ID: "777", ...env }, {
    fetchImpl,
    now: () => 1_000_000,
    loadCourses: async () => COURSES,
    createBillOrder: createBillOrder || (async (input, opts) => { calls.push({ input, opts }); return { status: 200, body: { success: true, orderId: "order-" + calls.length } }; })
  });
  return { convo, calls, state };
}

async function readyToPay(convo) {
  await convo.handle(PSID, msg("m1", { text: "hi" }));
  await convo.handle(PSID, msg("m2", { text: "Khoá TEST", quick_reply: { payload: "COURSE:khoa-test" } }));
  await convo.handle(PSID, msg("m3", { text: "mail mình là Hoc.Vien@Gmail.com nhé" }));
  await convo.handle(PSID, msg("m4", { text: "Đúng", quick_reply: { payload: "GMAIL_OK" } }));
}

test("signature: valid passes, wrong secret / missing / malformed fail", async () => {
  const body = new TextEncoder().encode('{"object":"page"}');
  assert.equal(await verifySignature(body, sign('{"object":"page"}'), SECRET), true);
  assert.equal(await verifySignature(body, sign('{"object":"page"}', "other"), SECRET), false);
  assert.equal(await verifySignature(body, null, SECRET), false);
  assert.equal(await verifySignature(body, "sha1=abc", SECRET), false);
  assert.equal(await verifySignature(body, sign('{"object":"page"}'), ""), false);
});

test("webhook GET: verify token echoes challenge, wrong token 403", async () => {
  const env = { META_VERIFY_TOKEN: "vt" };
  let res = await messengerWebhook(new Request("https://yeubep.shop/api/messenger-webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42"), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "42");
  res = await messengerWebhook(new Request("https://yeubep.shop/api/messenger-webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42"), env);
  assert.equal(res.status, 403);
  res = await messengerWebhook(new Request("https://yeubep.shop/api/messenger-webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=42"), {});
  assert.equal(res.status, 403);
});

function doNamespace() {
  const seen = [];
  return {
    seen,
    idFromName: (name) => name,
    get: (id) => ({ fetch: async (_url, init) => { seen.push({ id, ...JSON.parse(init.body) }); return new Response("ok"); } })
  };
}

const post = (body, headers = {}) => new Request("https://yeubep.shop/api/messenger-webhook", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
const payload = JSON.stringify({ object: "page", entry: [{ id: "555", messaging: [msg("m1", { text: "hi" })] }] });

test("webhook POST: bad or missing signature 401, nothing dispatched", async () => {
  const ns = doNamespace();
  const env = { META_APP_SECRET: SECRET, MESSENGER_BOT_ENABLED: "1", MESSENGER_CONVERSATIONS: ns };
  assert.equal((await messengerWebhook(post(payload), env)).status, 401);
  assert.equal((await messengerWebhook(post(payload, { "x-hub-signature-256": sign(payload, "x") }), env)).status, 401);
  assert.equal(ns.seen.length, 0);
});

test("webhook POST: signed + bot on dispatches per PSID; bot off or other Page dispatches nothing", async () => {
  const ns = doNamespace();
  const env = { META_APP_SECRET: SECRET, MESSENGER_BOT_ENABLED: "1", MESSENGER_CONVERSATIONS: ns, META_PAGE_ID: "555" };
  const res = await messengerWebhook(post(payload, { "x-hub-signature-256": sign(payload) }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(ns.seen.map((s) => s.id), [PSID]);
  await messengerWebhook(post(payload, { "x-hub-signature-256": sign(payload) }), { ...env, MESSENGER_BOT_ENABLED: "0" });
  await messengerWebhook(post(payload, { "x-hub-signature-256": sign(payload) }), { ...env, META_PAGE_ID: "666" });
  assert.equal(ns.seen.length, 1);
});

test("worker routes /api/messenger-webhook with security headers", async () => {
  const res = await worker.fetch(new Request("https://yeubep.shop/api/messenger-webhook?hub.mode=subscribe&hub.verify_token=x"), { ASSETS: { fetch: async () => new Response("") } });
  assert.equal(res.status, 403);
  assert.ok(res.headers.get("x-frame-options") || res.headers.get("content-security-policy"));
});

test("conversation: course -> Gmail confirm -> bill creates exactly one order", () => {
  let s = emptyState();
  let out = step(s, { kind: "postback", payload: "GET_STARTED" }, ctx());
  assert.match(out.replies[0].text, /trợ lý tự động/);
  assert.equal(out.replies[0].quick_replies[0].payload, "COURSE:khoa-test");
  out = step(out.state, { kind: "image", url: IMG }, ctx());
  assert.equal(out.action, undefined, "no order before course and Gmail");
  out = step(out.state, { kind: "text", text: "x", payload: "COURSE:khoa-test" }, ctx());
  assert.equal(out.state.course, "khoa-test");
  assert.ok(out.replies.some((r) => /0123/.test(r.text || "")), "bank info shown");
  out = step(out.state, { kind: "image", url: IMG }, ctx());
  assert.equal(out.action, undefined, "no order before Gmail is confirmed");
  out = step(out.state, { kind: "text", text: "a@gmail.com" }, ctx());
  assert.equal(out.state.gmail, "a@gmail.com");
  assert.equal(out.state.gmailOk, false);
  out = step(out.state, { kind: "text", text: "Đúng", payload: "GMAIL_OK" }, ctx());
  out = step(out.state, { kind: "image", url: IMG }, ctx());
  assert.deepEqual(out.action, { type: "createOrder", url: IMG });
});

test("conversation: unknown course, non-Gmail warning, Gmail re-entry", () => {
  let out = step(emptyState(), { kind: "text", text: "", payload: "COURSE:khoa-that" }, ctx());
  assert.equal(out.state.course, null);
  out = step({ ...emptyState(), course: "khoa-test" }, { kind: "text", text: "me@yahoo.com" }, ctx());
  assert.match(out.replies[0].text, /không phải tài khoản Google/);
  out = step(out.state, { kind: "text", text: "Sai", payload: "GMAIL_NO" }, ctx());
  assert.equal(out.state.gmail, null);
});

test("conversation: 'gặp người' and a human reply from the Page inbox pause the bot 12 hours", () => {
  let out = step(emptyState(), { kind: "text", text: "cho mình gặp admin" }, ctx());
  assert.equal(out.state.pausedUntil, 1_000_000 + PAUSE_MS);
  assert.equal(step(out.state, { kind: "text", text: "hi" }, ctx(1_000_001)).replies.length, 0);
  assert.ok(step(out.state, { kind: "text", text: "hi" }, ctx(1_000_000 + PAUSE_MS + 1)).replies.length > 0);
  out = step(emptyState(), { kind: "echo", fromThisApp: false }, ctx());
  assert.ok(out.state.pausedUntil > 0);
  out = step(emptyState(), { kind: "echo", fromThisApp: true }, ctx());
  assert.equal(out.state.pausedUntil, 0, "the bot's own echoes do not pause it");
});

test("toEvent: echo app id, quick reply, image, text, postback, receipts ignored", () => {
  assert.deepEqual(toEvent({ message: { is_echo: true, app_id: 777 } }, "777"), { kind: "echo", fromThisApp: true });
  assert.deepEqual(toEvent({ message: { is_echo: true } }, "777"), { kind: "echo", fromThisApp: false });
  assert.equal(toEvent({ message: { text: "x", quick_reply: { payload: "P" } } }).payload, "P");
  assert.equal(toEvent({ message: { attachments: [{ type: "image", payload: { url: IMG } }] } }).kind, "image");
  assert.equal(toEvent({ postback: { payload: "GET_STARTED" } }).kind, "postback");
  assert.equal(toEvent({ delivery: {} }), null);
});

test("DO: happy path creates one Facebook order, replies via Send API with header token", async () => {
  const f = fakeFetch();
  const { convo, calls } = conversation({ fetchImpl: f.impl });
  await readyToPay(convo);
  await convo.handle(PSID, msg("m5", { attachments: [{ type: "image", payload: { url: IMG } }] }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.gmail, "hoc.vien@gmail.com");
  assert.equal(calls[0].input.course, "khoa-test");
  assert.equal(calls[0].input.billType, "image/jpeg");
  assert.deepEqual(calls[0].opts.rawExtra, { channel: "facebook", psid: PSID });
  assert.match(f.sent.at(-1).body.message.text, /đã nhận bill/);
  assert.ok(f.sent.every((s) => s.auth === "Bearer page-token" && !s.url.includes("page-token")));
  // A second bill after the order does not create another order.
  await convo.handle(PSID, msg("m6", { attachments: [{ type: "image", payload: { url: IMG } }] }));
  assert.equal(calls.length, 1);
});

test("DO: Meta redelivery of the same mid is handled once", async () => {
  const f = fakeFetch();
  const { convo, calls } = conversation({ fetchImpl: f.impl });
  await readyToPay(convo);
  const ev = msg("m5", { attachments: [{ type: "image", payload: { url: IMG } }] });
  await convo.handle(PSID, ev);
  const sentBefore = f.sent.length;
  await convo.handle(PSID, ev);
  assert.equal(calls.length, 1);
  assert.equal(f.sent.length, sentBefore, "no reply to a duplicate");
});

test("DO: two bills sent at the same time create one order", async () => {
  const f = fakeFetch();
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const { convo } = conversation({
    fetchImpl: f.impl,
    createBillOrder: async (input) => { calls.push(input); await gate; return { status: 200, body: { orderId: "o1" } }; }
  });
  await readyToPay(convo);
  const a = convo.handle(PSID, msg("m5", { attachments: [{ type: "image", payload: { url: IMG } }] }));
  await new Promise((r) => setTimeout(r, 10));
  const b = convo.handle(PSID, msg("m6", { attachments: [{ type: "image", payload: { url: IMG } }] }));
  await new Promise((r) => setTimeout(r, 10));
  release();
  await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.ok(f.sent.some((s) => /đang xử lý bill/.test(s.body.message.text || "")));
});

test("DO: bill from a non-Meta host is refused, no order", async () => {
  const f = fakeFetch();
  const { convo, calls } = conversation({ fetchImpl: f.impl });
  await readyToPay(convo);
  await convo.handle(PSID, msg("m5", { attachments: [{ type: "image", payload: { url: "https://evil.example/x.jpg" } }] }));
  assert.equal(calls.length, 0);
  assert.match(f.sent.at(-1).body.message.text, /chưa ghi nhận được bill/);
});

test("downloadBill: host allowlist, redirect off-host, type and size", async () => {
  assert.equal((await downloadBill("http://scontent.xx.fbcdn.net/a.jpg")).error, "host_not_allowed");
  assert.equal((await downloadBill("https://fbcdn.net.evil.com/a.jpg")).error, "host_not_allowed");
  const redirected = async () => { const r = new Response("x", { headers: { "content-type": "image/jpeg" } }); Object.defineProperty(r, "url", { value: "https://evil.example/a" }); return r; };
  assert.equal((await downloadBill("https://scontent.xx.fbcdn.net/a.jpg", { fetchImpl: redirected })).error, "host_not_allowed");
  const html = async () => new Response("x", { headers: { "content-type": "text/html" } });
  assert.equal((await downloadBill("https://scontent.xx.fbcdn.net/a.jpg", { fetchImpl: html })).error, "type_not_allowed");
  const big = async () => new Response("x", { headers: { "content-type": "image/png", "content-length": String(6 * 1024 * 1024) } });
  assert.equal((await downloadBill("https://scontent.xx.fbcdn.net/a.jpg", { fetchImpl: big })).error, "too_large");
});

test("approval notice: only Facebook orders, only when the bot is on, failures reported not thrown", async () => {
  const f = fakeFetch();
  const order = { course_title: "Khoá TEST", customer_email: "a@gmail.com", raw_data: { channel: "facebook", psid: PSID } };
  assert.equal(await notifyApprovedOrder({ raw_data: {} }, { env: { MESSENGER_BOT_ENABLED: "1" } }), null);
  assert.equal(await notifyApprovedOrder(order, { env: { MESSENGER_BOT_ENABLED: "0" } }), "SKIPPED_BOT_OFF");
  const env = { MESSENGER_BOT_ENABLED: "1", META_PAGE_ACCESS_TOKEN: "page-token", V5_LMS_PUBLIC_URL: "https://hoc.yeubep.shop" };
  assert.equal(await notifyApprovedOrder(order, { env, fetchImpl: f.impl }), "SENT");
  assert.match(f.sent[0].body.message.text, /https:\/\/hoc\.yeubep\.shop\/my-courses\.html.*a@gmail\.com/);
  const failing = async () => new Response('{"error":{"code":10,"error_subcode":2018278}}', { status: 400 });
  assert.equal(await notifyApprovedOrder(order, { env, fetchImpl: failing }), "FAILED");
});

test("orders API notifies after a successful V5 approval only", () => {
  const src = readFileSync(new URL("../api/orders.js", import.meta.url), "utf8");
  assert.match(src, /const result = await approveV5Order\(orderForSync, updateData\);\s*if \(!result\.ok\) return[^\n]*\n\s*const messenger = await notifyApprovedOrder/);
});

test("Admin orders page escapes buyer-controlled fields", () => {
  const html = readFileSync(new URL("../orders.html", import.meta.url), "utf8");
  for (const raw of ["${order.customer_name}", "${order.customer_phone}", "${order.sync_error}", "${order.billLink}", "copyText('${gmail}')"]) {
    assert.ok(!html.includes(raw), raw);
  }
  assert.match(html, /const gmail = escapeHtml\(order\.gmail \|\| ""\);/);
});

test("after an order, a text gets this sender's own order status (24-hour window reopened)", async () => {
  const f = fakeFetch();
  const lookups = [];
  const { convo } = conversation({ fetchImpl: f.impl });
  convo.deps.loadOrder = async (id) => { lookups.push(id); return { status: "Đã duyệt", course_title: "Khoá TEST", customer_email: "hoc.vien@gmail.com" }; };
  await readyToPay(convo);
  await convo.handle(PSID, msg("m5", { attachments: [{ type: "image", payload: { url: IMG } }] }));
  // Typing someone else's Gmail does not change whose order is looked up.
  await convo.handle(PSID, msg("m6", { text: "khac@gmail.com duyệt chưa?" }));
  assert.deepEqual(lookups, ["order-1"]);
  assert.match(f.sent.at(-1).body.message.text, /đã được duyệt.*hoc\.vien@gmail\.com/s);
  convo.deps.loadOrder = async () => ({ status: "Chờ duyệt" });
  await convo.handle(PSID, msg("m7", { text: "?" }));
  assert.match(f.sent.at(-1).body.message.text, /đang chờ Admin xác nhận/);
});

test("greeting is the Owner text and says it is automated", () => {
  const out = step(emptyState(), { kind: "postback", payload: "GET_STARTED" }, ctx());
  assert.match(out.replies[0].text, /^Chào bạn! 👋 Mình là trợ lý tự động của Yêu Bếp\./);
});

test("Admin is told to message the buyer by hand when the approval notice fails", () => {
  const html = readFileSync(new URL("../orders.html", import.meta.url), "utf8");
  assert.match(html, /syncResults\?\.messenger === "FAILED"[\s\S]{0,80}alert\(/);
});
