// Messenger V2 UX (G-V2-ux-code): U1-U7 + U6b. UX-01..UX-46 follow the numbered tests of CLAUDE_MESSENGER_V2_UX_FIX_20261109.md.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  step, stepRaw, renderReplies, menuButtons, emptyState, normalizeState, MENU3, busyReplies, ordersSummaryReplies,
  NO_PENDING_TEXT, NO_ORDERS_TEXT, UNVERIFIED_TEXT
} from "../utils/messenger/bot.js";
import { MessengerConversation, loadCourses, loadPendingOrders } from "../cloudflare/commerce-worker/src/messenger.js";

const PSID = "1234567890123";
const OTHER_PSID = "9999999999999";
const PAGE = "555";
const A = { slug: "khoa-a", title: "Khóa A", price: "100.000đ", subtitle: "Mô tả A", description: "", bankName: "VCB", bankAccount: "0123", bankOwner: "X", transferNote: "A", qrImageUrl: "", imageUrl: "https://img.example/a.jpg", featured: false };
const B = { slug: "khoa_b", title: "Khóa B", price: "200.000đ", subtitle: "", description: "Dòng 1\nDòng 2", bankName: "VCB", bankAccount: "0456", bankOwner: "X", transferNote: "B", qrImageUrl: "", imageUrl: "", featured: true };
const COURSES = [B, A];
const ctx = (extra = {}) => ({ now: 1_000_000, courses: COURSES, ticketsEnabled: true, faq: [], activeTicket: null, commerceUrl: "https://shop.example", ...extra });
const txt = (text, payload) => ({ kind: "text", text, ...(payload ? { payload } : {}) });
const pb = (payload) => ({ kind: "postback", payload });
const G = { ...emptyState(), greeted: true };
const payloads = (m) => [...(m.attachment?.payload?.buttons || []), ...(m.quick_replies || [])].map((q) => q.payload);
const textOf = (m) => m.text ?? m.attachment?.payload?.text;
const elements = (m) => m.attachment.payload.elements;
const manyCourses = (n) => Array.from({ length: n }, (_, i) => ({ ...A, slug: `c${i}`, title: `Khóa số ${i}` }));
const show = { pendingMenu: "show", pendingSlugs: new Set(), doOrderIds: [] };
const hide = { pendingMenu: "hide", pendingSlugs: new Set(), doOrderIds: [] };

// ---- fake DB for orders: records every command and filter ----
const ord = (id, slug, o = {}) => ({
  id, status: o.status ?? "Chờ duyệt", course_slug: slug, course_title: o.title ?? slug.toUpperCase(), created_at: o.at ?? "2026-11-09T10:00:00Z",
  raw_data: { channel: "facebook", psid: o.psid ?? PSID, ...(o.pageId === null ? {} : { pageId: o.pageId ?? PAGE }) }
});
function ordersDb(rows, { fail = false, lax = false } = {}) {
  const db = { log: [], rows, fail, lax };
  db.from = (table) => {
    const q = { table, op: "select", eqs: [], or: null, lim: null };
    const api = {
      select: () => api, insert: () => { q.op = "insert"; return api; }, update: () => { q.op = "update"; return api; }, delete: () => { q.op = "delete"; return api; },
      eq: (k, v) => { q.eqs.push([k, v]); return api; }, or: (c) => { q.or = c; return api; }, order: () => api, limit: (n) => { q.lim = n; return api; }, abortSignal: () => api,
      then: (res) => {
        db.log.push(q);
        if (db.fail) return res({ data: null, error: { message: "down" } });
        const pageEq = /raw_data->>pageId\.eq\.(\d+)/.exec(q.or || "")?.[1];
        const hit = db.rows.filter((r) => db.lax || (q.eqs.every(([k, v]) => (k === "status" ? r.status === v : k === "raw_data->>psid" ? r.raw_data.psid === v : true))
          && (q.or === null || r.raw_data.pageId === pageEq || r.raw_data.pageId == null)));
        return res({ data: [...hit].sort((a, b) => a.created_at.localeCompare(b.created_at)), error: null });
      }
    };
    return api;
  };
  return db;
}

// ---- Durable Object harness (fake storage, fake Send API, injected deps) ----
function fakeStorage() {
  const map = new Map();
  return { map, async get(k) { return map.has(k) ? structuredClone(map.get(k)) : undefined; }, async put(k, v) { map.set(k, structuredClone(v)); } };
}
const IMG = "https://scontent.xx.fbcdn.net/v/bill.jpg";
function harness({ rows = [], courses = COURSES, statuses = {}, tickets = true, dbOpts = {}, env = {}, deps = {} } = {}) {
  const sent = [];
  const orders = [];
  const db = ordersDb(rows, dbOpts);
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://graph.facebook.com/")) { sent.push(JSON.parse(init.body).message); return new Response("{}", { status: 200 }); }
    const res = new Response(new Uint8Array([0xff, 0xd8, 0xff, 1]), { status: 200, headers: { "content-type": "image/jpeg" } });
    Object.defineProperty(res, "url", { value: u });
    return res;
  };
  const storage = fakeStorage();
  const convo = new MessengerConversation({ storage }, { META_PAGE_ACCESS_TOKEN: "t", META_APP_ID: "777", META_PAGE_ID: PAGE, ...(tickets ? { MESSENGER_TICKETS_ENABLED: "1" } : {}), ...env }, {
    fetchImpl, now: () => 1_000_000, loadCourses: async () => courses, loadFaq: () => [],
    activeTicket: async () => null, openTicket: async () => ({ ok: true }), touchTicket: async () => {},
    loadOrder: async (id) => statuses[id] ?? null,
    loadPendingOrders: (a) => loadPendingOrders(a, db),
    // G-LIVE-ux F-A1: the orders view reads through loadMyOrders; these tests keep the pending-only fake DB (statuses are tested in messenger-glive-ux).
    loadMyOrders: async (a) => (await loadPendingOrders(a, db)).map((r) => ({ ...r, status: "Chờ duyệt", email: "" })),
    loadCourseOrders: async () => [],
    createBillOrder: async (input, opts) => { orders.push({ input, opts }); return { status: 200, body: { orderId: `new${orders.length}` } }; },
    ...deps
  });
  let n = 0;
  const h = { convo, sent, orders, db, storage };
  const run = async (ev) => { const before = sent.length; await convo.handle(PSID, { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, message: { mid: `m${++n}`, ...ev } }); return sent.slice(before); };
  h.say = (text) => run({ text });
  h.press = (payload) => run({ text: "x", quick_reply: { payload } });
  h.img = () => run({ attachments: [{ type: "image", payload: { url: IMG } }] });
  h.seed = (state) => storage.put("s", { state: { ...emptyState(), greeted: true, ...state }, mids: [], hits: [] });
  h.state = async () => (await storage.get("s")).state;
  h.buy = async (slug, gmail) => { await h.press(`BUY:${slug}`); await h.say(gmail); await h.press("GMAIL_OK"); await h.img(); };
  return h;
}
const writes = (db) => db.log.filter((q) => q.op !== "select");
const lastOf = (msgs) => msgs.at(-1);

// ---- limits checker (UX-12, UX-46) ----
function checkLimits(m) {
  if (m.quick_replies) {
    assert.ok(m.quick_replies.length <= 13, "quick replies <= 13");
    for (const q of m.quick_replies) if (q.content_type === "text") assert.ok(q.title.length <= 20, q.title);
  }
  if (m.attachment?.payload?.template_type === "button") {
    const { text, buttons } = m.attachment.payload;
    assert.ok(buttons.length >= 1 && buttons.length <= 3, "button template: 1-3 buttons");
    assert.ok(text.length <= 640, "button template text <= 640");
    for (const b of buttons) assert.ok(b.type === "postback" && b.title.length <= 20, b.title);
  } else if (m.attachment) {
    const els = elements(m);
    assert.ok(els.length <= 10, "elements <= 10");
    for (const e of els) {
      assert.ok(e.buttons.length <= 3, "buttons <= 3");
      assert.ok(e.title.length <= 80 && e.subtitle.length <= 80);
      for (const b of e.buttons) assert.ok(b.title.length <= 20, b.title);
    }
  }
}
function sweep() {
  const out = [];
  const draft = { ...G, course: "khoa-a", orders: [{ id: "o1", slug: "khoa_b" }] };
  const events = [txt("hi"), txt("menu"), pb("GET_STARTED"), pb("RESTART"), pb("CANCEL_DRAFT"), pb("CONTINUE_DRAFT"), pb("BUY:khoa-a"), pb("BUY:zzz"), pb("LIST"), pb("LIST:2"), pb("GMAIL_NO"), txt("qwer asdf"), txt("me@x.com"), txt("kh")];
  for (const n of [0, 1, 3, 10, 11, 25]) {
    for (const view of [show, hide]) {
      for (const st of [G, draft, { ...draft, gmail: "a@x.com" }, { ...draft, gmail: "a@x.com", gmailOk: true }]) {
        for (const e of events) out.push(...renderReplies(stepRaw(st, e, ctx({ courses: manyCourses(n) })).replies, view, ctx({ courses: manyCourses(n) })));
      }
    }
  }
  out.push(...renderReplies(stepRaw(G, pb("LIST:2"), ctx({ courses: manyCourses(25) })).replies, hide, ctx({ courses: manyCourses(25) })));
  return out;
}

// ======== U1-U5 ========
test("UX-01 pending order A: BUY:A says so, offers LIST_OTHER and MENU, opens no draft, creates no order", async () => {
  const h = harness({ statuses: { oA: { status: "Chờ duyệt" } } });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA" });
  const m = lastOf(await h.press("BUY:khoa-a"));
  assert.equal(m.text, "Bạn đã có đơn khóa này đang chờ Admin xác nhận.");
  assert.deepEqual(payloads(m), ["LIST_OTHER", "PENDING_ORDERS", "MENU"]);
  assert.equal((await h.state()).course, null);
  assert.equal(h.orders.length, 0);
});

test("UX-02 LIST_OTHER lists B without A; picking B opens the draft for B and A stays in orders", async () => {
  const h = harness({ statuses: { oA: { status: "Chờ duyệt" } } });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA" });
  const list = lastOf(await h.press("LIST_OTHER"));
  assert.deepEqual(elements(list).map((e) => e.buttons.at(-1).payload), ["BUY:khoa_b"]);
  await h.press("BUY:khoa_b");
  const s = await h.state();
  assert.equal(s.course, "khoa_b");
  assert.deepEqual(s.orders, [{ id: "oA", slug: "khoa-a" }]);
});

test("UX-03 bill for B creates exactly one order (slug B); orders = [A, B], A id unchanged", async () => {
  const h = harness({ statuses: { oA: { status: "Chờ duyệt" } } });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA" });
  await h.buy("khoa_b", "b@gmail.com");
  assert.deepEqual(h.orders.map((o) => o.input.course), ["khoa_b"]);
  assert.deepEqual((await h.state()).orders, [{ id: "oA", slug: "khoa-a" }, { id: "new1", slug: "khoa_b" }]);
});

test("UX-04 A and B both ordered: LIST_OTHER says no other course, with MENU", async () => {
  const h = harness({ statuses: { oA: { status: "Chờ duyệt" }, oB: { status: "Chờ duyệt" } } });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }, { id: "oB", slug: "khoa_b" }] });
  const m = lastOf(await h.press("LIST_OTHER"));
  assert.equal(m.text, "Hiện chưa có khóa nào khác đang mở đăng ký.");
  assert.deepEqual(payloads(m), ["MENU"]);
  assert.ok(!m.attachment);
});

test("UX-05 approved order A: approved notice + LIST_OTHER + MENU; BUY:A opens no draft", async () => {
  const h = harness({ statuses: { oA: { status: "Đã duyệt", course_title: "Khóa A", customer_email: "a@gmail.com" } } });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }] });
  const m = lastOf(await h.press("BUY:khoa-a"));
  assert.match(m.text, /Đơn khoá "Khóa A" đã được duyệt/);
  assert.deepEqual(payloads(m), ["LIST_OTHER", "MENU"]);
  assert.equal((await h.state()).course, null);
});

test("UX-06 draft B, 'hi' (and 'menu') shows the menu with Tiếp tục/Hủy đăng ký; the draft stays", () => {
  const st = { ...G, course: "khoa_b" };
  for (const e of [txt("hi"), txt("menu"), pb("MENU")]) {
    const out = step(st, e, ctx());
    assert.deepEqual(payloads(out.replies.at(-1)), ["BUY", "LIST", "ADMIN", "CONTINUE_DRAFT", "CANCEL_DRAFT"], JSON.stringify(e));
    assert.equal(out.state.course, "khoa_b");
  }
  assert.equal(step({ ...st, gmail: "a@gmail.com" }, pb("CONTINUE_DRAFT"), ctx()).replies[0].text, 'Đăng ký khóa "Khóa B" bằng Gmail a@gmail.com. Đúng không?');
  assert.equal(step(st, txt("bắt đầu lại"), ctx()).state.course, null, "RESTART still works");
});

test("UX-07 CANCEL_DRAFT clears the draft, keeps orders, writes nothing to the DB", async () => {
  const h = harness();
  const orders = [{ id: "oA", slug: "khoa-a" }];
  await h.seed({ orders, orderId: "oA", course: "khoa_b", gmail: "b@gmail.com", gmailOk: true, pendingAdmin: "support", ref: "c__khoa_b" });
  const m = lastOf(await h.press("CANCEL_DRAFT"));
  assert.match(textOf(m), /^Đã hủy đăng ký dở\. /);
  const s = await h.state();
  assert.deepEqual([s.course, s.gmail, s.gmailOk, s.pendingAdmin, s.ref], [null, null, false, null, null]);
  assert.deepEqual(s.orders, orders);
  assert.equal(writes(h.db).length, 0);
});

test("UX-08 draft B: first stray text repeats Gmail with exit buttons, second runs free text; the draft stays", () => {
  const st = { ...G, course: "khoa_b" };
  const one = step(st, txt("blah blah"), ctx());
  // G-LIVE-ux F-A8: T9 adds the example "ten@gmail.com".
  assert.equal(one.replies[0].text, "Bạn gửi Gmail dùng để học (đăng nhập Google trên trang học), ví dụ ten@gmail.com nhé.");
  assert.deepEqual(one.replies[0].quick_replies.map((q) => q.payload ?? q.content_type), ["user_email", "CHANGE_COURSE", "CANCEL_DRAFT", "ADMIN"]); // U9 adds "Đổi khóa học"
  assert.equal(one.state.draftMisses, 1);
  const two = step(one.state, txt("blah blah"), ctx());
  assert.match(textOf(two.replies[0]), /^Mình chưa hiểu ý bạn\./);
  assert.equal(two.state.course, "khoa_b");
  assert.equal(step(one.state, txt("a@gmail.com"), ctx()).state.draftMisses, 0, "valid e-mail resets");
  assert.equal(step(one.state, pb("ADMIN"), ctx()).state.draftMisses, 0, "any button resets");
});

// G-LIVE-ux F-A6: a typo only counts for words of 5+ letters ("bnah" is 4 letters), so the test uses "chiffon".
test("UX-09 typo 'khoa chifon': one close course asks, two list; nothing is assigned", () => {
  const banhMi = { ...A, slug: "banh-mi", title: "Làm Chiffon" };
  const banhBao = { ...A, slug: "banh-bao", title: "Làm Chiffoa" };
  const one = step(G, txt("khoa chiffo"), ctx({ courses: [banhMi, { ...B, title: "Pha chế" }] }));
  assert.equal(one.replies[0].text, "Bạn muốn hỏi khóa Làm Chiffon?");
  assert.deepEqual(one.replies[0].quick_replies.map((q) => [q.title, q.payload]), [["Đúng", "INFO:banh-mi:general"], ["Không", "LIST"]]);
  assert.equal(one.state.course, null);
  const two = step(G, txt("khoa chiffo"), ctx({ courses: [banhMi, banhBao] }));
  assert.equal(two.state.course, null);
  assert.equal(elements(two.replies.at(-1)).length, 2);
  assert.match(two.replies[0].text, /^Có 2 khóa/);
});

test("UX-10 image with an incomplete draft reminds the missing step and creates no order", async () => {
  const h = harness();
  await h.seed({ course: "khoa_b" });
  const m = lastOf(await h.img());
  assert.equal(m.text, "Bạn gửi Gmail dùng để học (đăng nhập Google trên trang học), ví dụ ten@gmail.com nhé."); // G-LIVE-ux: T9
  assert.equal(h.orders.length, 0);
});

test("UX-11 Pham Hung: orderId without orders -> A added; BUY:A pending; LIST_OTHER shows B; bill B -> 2 orders", async () => {
  const old = { orderId: "oA", course: "khoa-a", gmail: "a@gmail.com", gmailOk: true };
  assert.deepEqual(normalizeState(old).orders, [{ id: "oA", slug: "khoa-a" }]);
  const h = harness({ statuses: { oA: { status: "Chờ duyệt" } } });
  await h.seed(old);
  assert.equal(lastOf(await h.press("BUY:khoa-a")).text, "Bạn đã có đơn khóa này đang chờ Admin xác nhận.");
  assert.deepEqual(elements(lastOf(await h.press("LIST_OTHER"))).map((e) => e.buttons.at(-1).payload), ["BUY:khoa_b"]);
  await h.buy("khoa_b", "b@gmail.com");
  assert.equal(h.orders.length, 1);
  assert.deepEqual((await h.state()).orders.map((o) => o.id), ["oA", "new1"]);
});

test("UX-12 every quick reply title <= 20 characters and <= 13 per message", () => {
  const all = sweep();
  assert.ok(all.length > 100);
  for (const m of all) {
    if (!m.quick_replies) continue;
    assert.ok(m.quick_replies.length <= 13);
    for (const q of m.quick_replies) if (q.content_type === "text") assert.ok(q.title.length <= 20, q.title);
  }
});

// ======== U6: pending orders ========
test("UX-13 no pending order: exact sentence + LIST_OTHER + MENU", async () => {
  const h = harness();
  await h.seed({});
  const m = lastOf(await h.press("PENDING_ORDERS"));
  // G-LIVE-ux F-A1: the button now reads pending + approved orders; none = T8 with Chat với Admin.
  assert.equal(m.text, NO_ORDERS_TEXT);
  assert.deepEqual(payloads(m), ["ADMIN", "MENU"]);
});

test("UX-14 one pending order: title, one line (course + bill date in Vietnam time), 2 buttons", async () => {
  const h = harness({ rows: [ord("oA", "khoa-a", { title: "Khóa A", at: "2026-11-09T18:00:00Z" })] });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }] });
  const m = lastOf(await h.say("đơn của tôi"));
  // G-LIVE-ux F-A1: T7 text and buttons.
  assert.equal(m.text, "Đơn của bạn:\nKhóa A — Chờ duyệt (gửi bill 10/11/2026)");
  assert.deepEqual(payloads(m), ["ADMIN", "LIST_OTHER", "MENU"]);
  assert.ok(!/oA|1234567890123|@/.test(m.text), "no id, PSID or Gmail");
});

test("UX-15 several pending orders: one line each in created_at order; two orders of the same course are not merged", async () => {
  const rows = [ord("o3", "khoa-a", { title: "Khóa A", at: "2026-11-09T12:00:00Z" }), ord("o1", "khoa-a", { title: "Khóa A", at: "2026-11-05T12:00:00Z" }), ord("o2", "khoa_b", { title: "Khóa B", at: "2026-11-07T12:00:00Z" })];
  const h = harness({ rows });
  await h.seed({ orders: [{ id: "o1", slug: "khoa-a" }, { id: "o2", slug: "khoa_b" }, { id: "o3", slug: "khoa-a" }] });
  const m = lastOf(await h.press("PENDING_ORDERS"));
  // G-LIVE-ux F-A1: T7 line format.
  assert.equal(m.text, "Đơn của bạn:\nKhóa A — Chờ duyệt (gửi bill 05/11/2026)\nKhóa B — Chờ duyệt (gửi bill 07/11/2026)\nKhóa A — Chờ duyệt (gửi bill 09/11/2026)");
});

test("UX-16 order approved in the DB is gone from the list although the DO still holds it", async () => {
  const rows = [ord("oA", "khoa-a", { status: "Đã duyệt" }), ord("oB", "khoa_b", { title: "Khóa B" })];
  const h = harness({ rows });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }, { id: "oB", slug: "khoa_b" }] });
  assert.equal(lastOf(await h.press("PENDING_ORDERS")).text, "Đơn của bạn:\nKhóa B — Chờ duyệt (gửi bill 09/11/2026)"); // G-LIVE-ux: T7
  rows[1].status = "Từ chối";
  assert.equal(lastOf(await h.press("PENDING_ORDERS")).text, NO_ORDERS_TEXT); // G-LIVE-ux: T8
});

test("UX-17 mixed statuses: only the Chờ duyệt line is shown", async () => {
  const rows = [ord("o1", "khoa-a", { title: "Khóa A" }), ord("o2", "khoa_b", { status: "Đã duyệt" }), ord("o3", "x", { status: "Từ chối" }), ord("o4", "y", { status: "Hủy" })];
  for (const lax of [false, true]) {
    const h = harness({ rows, dbOpts: { lax } });
    await h.seed({ orders: rows.map((r) => ({ id: r.id, slug: r.course_slug })) });
    const m = lastOf(await h.press("PENDING_ORDERS"));
    assert.ok(m.text.includes("Khóa A"));
    assert.ok(!/Khóa B|X —|Y —/.test(m.text.replace("Đơn của bạn:", "")) || lax, "DB filters status");
  }
  const h = harness({ rows });
  assert.ok(h.db.log.length === 0);
  await h.seed({ orders: [{ id: "o1", slug: "khoa-a" }] });
  await h.press("PENDING_ORDERS");
  assert.deepEqual(h.db.log[0].eqs.find(([k]) => k === "status"), ["status", "Chờ duyệt"]);
});

test("UX-18 other PSID or other Page: never listed (DB filter and the JS re-check)", async () => {
  const rows = [ord("o1", "khoa-a", { psid: OTHER_PSID }), ord("o2", "khoa_b", { pageId: "777" })];
  for (const lax of [false, true]) {
    const h = harness({ rows, dbOpts: { lax } });
    await h.seed({ orders: [{ id: "o1", slug: "khoa-a" }, { id: "o2", slug: "khoa_b" }] });
    assert.equal(lastOf(await h.press("PENDING_ORDERS")).text, NO_ORDERS_TEXT, `lax=${lax}`); // G-LIVE-ux: T8
  }
  const h = harness({ rows });
  await h.seed({});
  await h.press("PENDING_ORDERS");
  const q = h.db.log[0];
  assert.deepEqual(q.eqs.find(([k]) => k === "raw_data->>psid"), ["raw_data->>psid", PSID]);
  assert.equal(q.or, `raw_data->>pageId.eq.${PAGE},raw_data->>pageId.is.null`);
  assert.equal(q.lim, 50);
});

test("UX-19 old order without pageId: shown only when its id is in the DO and the PSID matches", async () => {
  const rows = [ord("inDo", "khoa-a", { title: "Khóa A", pageId: null }), ord("notInDo", "khoa_b", { title: "Khóa B", pageId: null }), ord("otherPsid", "khoa_b", { title: "Khóa B", pageId: null, psid: OTHER_PSID })];
  const h = harness({ rows, dbOpts: { lax: true } });
  await h.seed({ orders: [{ id: "inDo", slug: "khoa-a" }, { id: "otherPsid", slug: "khoa_b" }] });
  const m = lastOf(await h.press("PENDING_ORDERS"));
  assert.equal(m.text, `Đơn của bạn:\nKhóa A — Chờ duyệt (gửi bill 09/11/2026)\n\n${UNVERIFIED_TEXT}`); // G-LIVE-ux: T7
  assert.ok(!m.text.includes("Khóa B"));
});

test("UX-20 DB error on 'Đơn chờ duyệt': busy message with Admin, never the 'no orders' sentence", async () => {
  const h = harness({ dbOpts: { fail: true } });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }] });
  const m = lastOf(await h.press("PENDING_ORDERS"));
  assert.equal(m.text, "Hệ thống đang bận, bạn thử lại sau ít phút nhé.");
  assert.ok(payloads(m).includes("ADMIN"));
  assert.ok(!h.sent.some((x) => (x.text || "").includes("không có đơn")));
});

test("UX-21 reading orders is read-only: no insert/update/delete, DO state unchanged", async () => {
  const h = harness({ rows: [ord("oA", "khoa-a")], statuses: { oA: { status: "Chờ duyệt" } } });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA", course: "khoa_b" });
  const before = await h.state();
  await h.press("PENDING_ORDERS");
  await h.press("LIST_OTHER");
  await h.say("kiểm tra đơn");
  assert.equal(writes(h.db).length, 0);
  assert.ok(h.db.log.length > 0);
  const after = await h.state();
  assert.deepEqual([after.orders, after.course, after.orderId], [before.orders, before.course, before.orderId]);
});

test("UX-22 createBillOrder gets rawExtra.pageId = META_PAGE_ID; the bill still creates exactly one order", async () => {
  const h = harness();
  await h.buy("khoa-a", "a@gmail.com");
  assert.equal(h.orders.length, 1);
  assert.deepEqual(h.orders[0].opts.rawExtra, { channel: "facebook", psid: PSID, pageId: PAGE });
  const noPage = harness({ env: { META_PAGE_ID: "" } });
  await noPage.buy("khoa-a", "a@gmail.com");
  assert.deepEqual(noPage.orders[0].opts.rawExtra, { channel: "facebook", psid: PSID });
});

test("UX-23 menu: with 'Đơn của tôi' 4 buttons in the right order, without 3 as before; titles <= 20", () => {
  assert.deepEqual(menuButtons("show", false), [["Đăng ký khóa học", "BUY"], ["Xem khóa đang mở bán", "LIST"], ["Đơn của tôi", "PENDING_ORDERS"], ["Chat với Admin", "ADMIN"]]);
  assert.deepEqual(menuButtons("hide", true), MENU3);
  assert.equal(MENU3.length, 3);
  for (const [t] of [...menuButtons("show", false), ...menuButtons("hide", false, [["Tiếp tục đăng ký", "CONTINUE_DRAFT"], ["Hủy đăng ký", "CANCEL_DRAFT"]])]) assert.ok(t.length <= 20, t);
});

test("UX-24 R1: pending order, no pageId, id not in the DO -> the exact Admin sentence + ADMIN + MENU (not 'no orders')", async () => {
  const h = harness({ rows: [ord("lost", "khoa-a", { pageId: null })] });
  await h.seed({});
  const m = lastOf(await h.press("PENDING_ORDERS"));
  assert.equal(m.text, "Mình chưa xác minh được một số đơn của bạn. Bạn bấm Chat với Admin để được kiểm tra nhé.");
  assert.deepEqual(payloads(m), ["ADMIN", "MENU"]);
});

test("UX-25 empty or odd META_PAGE_ID: no query, busy message", async () => {
  for (const bad of ["", "  ", "12ab", "1".repeat(40)]) {
    const db = ordersDb([]);
    await assert.rejects(loadPendingOrders({ psid: PSID, pageId: bad }, db));
    assert.equal(db.log.length, 0, `pageId=${JSON.stringify(bad)}`);
  }
  const h = harness({ env: { META_PAGE_ID: "" }, rows: [ord("o1", "khoa-a")] });
  await h.seed({ orders: [{ id: "o1", slug: "khoa-a" }] });
  const m = lastOf(await h.press("PENDING_ORDERS"));
  assert.equal(m.text, "Hệ thống đang bận, bạn thử lại sau ít phút nhé.");
  assert.equal(h.db.log.length, 0);
});

// ======== U6b: the button per customer ========
test("UX-26 new customer: 'hi' shows 3 buttons, no PENDING_ORDERS", async () => {
  const h = harness();
  await h.seed({});
  assert.deepEqual(payloads(lastOf(await h.say("hi"))), ["BUY", "LIST", "ADMIN"]);
});

test("UX-27 one pending order (with pageId): 'hi' shows 4 buttons", async () => {
  const h = harness({ rows: [ord("o1", "khoa-a")] });
  await h.seed({ orders: [{ id: "o1", slug: "khoa-a" }] });
  assert.deepEqual(payloads(lastOf(await h.say("hi"))), ["BUY", "LIST", "PENDING_ORDERS", "ADMIN"]);
});

test("UX-28 several pending orders: exactly one PENDING_ORDERS button; pressing it lists each order", async () => {
  const rows = [ord("o1", "khoa-a", { title: "Khóa A" }), ord("o2", "khoa_b", { title: "Khóa B" }), ord("o3", "khoa_b", { title: "Khóa B", at: "2026-11-10T01:00:00Z" })];
  const h = harness({ rows });
  await h.seed({ orders: rows.map((r) => ({ id: r.id, slug: r.course_slug })) });
  assert.equal(payloads(lastOf(await h.say("hi"))).filter((p) => p === "PENDING_ORDERS").length, 1);
  assert.equal(lastOf(await h.press("PENDING_ORDERS")).text.split("\n").length, 4); // header + 3 lines (G-LIVE-ux: T7 header "Đơn của bạn:")
});

test("UX-29 no pending order -> 3 buttons; button present, Admin approves, next 'hi' has no button", async () => {
  const rows = [ord("o1", "khoa-a", { status: "Đã duyệt" }), ord("o2", "khoa_b", { status: "Từ chối" }), ord("o3", "x", { status: "Hủy" })];
  const h = harness({ rows });
  await h.seed({ orders: rows.map((r) => ({ id: r.id, slug: r.course_slug })) });
  assert.deepEqual(payloads(lastOf(await h.say("hi"))), ["BUY", "LIST", "ADMIN"]);
  const h2 = harness({ rows: [ord("o1", "khoa-a")] });
  await h2.seed({ orders: [{ id: "o1", slug: "khoa-a" }] });
  assert.ok(payloads(lastOf(await h2.say("hi"))).includes("PENDING_ORDERS"));
  h2.db.rows[0].status = "Đã duyệt";
  assert.ok(!payloads(lastOf(await h2.say("hi"))).includes("PENDING_ORDERS"), "no cache: read again");
});

test("UX-30 pending order of another PSID or another Page: no button", async () => {
  for (const lax of [false, true]) {
    const h = harness({ rows: [ord("o1", "khoa-a", { psid: OTHER_PSID }), ord("o2", "khoa_b", { pageId: "777" })], dbOpts: { lax } });
    await h.seed({ orders: [{ id: "o1", slug: "khoa-a" }, { id: "o2", slug: "khoa_b" }] });
    assert.deepEqual(payloads(lastOf(await h.say("hi"))), ["BUY", "LIST", "ADMIN"], `lax=${lax}`);
  }
});

test("UX-31 old order without pageId: button when its id is in the DO; button also in R1, pressing it gives the R1 sentence", async () => {
  const h = harness({ rows: [ord("o1", "khoa-a", { pageId: null })] });
  await h.seed({ orders: [{ id: "o1", slug: "khoa-a" }] });
  assert.ok(payloads(lastOf(await h.say("hi"))).includes("PENDING_ORDERS"));
  const lost = harness({ rows: [ord("o1", "khoa-a", { pageId: null })] });
  await lost.seed({});
  assert.ok(payloads(lastOf(await lost.say("hi"))).includes("PENDING_ORDERS"));
  assert.equal(lastOf(await lost.press("PENDING_ORDERS")).text, UNVERIFIED_TEXT);
});

test("UX-32 DB error while building the menu and the DO holds an order id: button shown; pressing it with the DB still down gives busy + ADMIN", async () => {
  const h = harness({ dbOpts: { fail: true } });
  await h.seed({ orders: [{ id: "o1", slug: "khoa-a" }] });
  assert.ok(payloads(lastOf(await h.say("hi"))).includes("PENDING_ORDERS"));
  const m = lastOf(await h.press("PENDING_ORDERS"));
  assert.equal(m.text, "Hệ thống đang bận, bạn thử lại sau ít phút nhé.");
  assert.ok(payloads(m).includes("ADMIN"));
  assert.ok(!h.sent.some((x) => (x.text || "").includes("không có đơn")));
});

test("UX-33 DB error while building the menu and the DO is empty: 3 buttons, no 'no orders' sentence", async () => {
  const h = harness({ dbOpts: { fail: true } });
  await h.seed({});
  const m = lastOf(await h.say("hi"));
  assert.deepEqual(payloads(m), ["BUY", "LIST", "ADMIN"]);
  assert.ok(!h.sent.some((x) => (x.text || "").includes("không có đơn")));
});

test("UX-34 messages without the menu (Gmail ask, payment info) run no order query", async () => {
  const h = harness({ rows: [ord("o1", "khoa-a")] });
  await h.seed({});
  await h.press("BUY:khoa-a");
  await h.say("a@gmail.com");
  await h.press("GMAIL_OK");
  assert.equal(h.db.log.length, 0);
  await h.say("hi");
  assert.equal(h.db.log.length, 1, "a menu costs exactly one read");
});

test("UX-35 B6: every main-menu message is a placeholder rendered by one builder; MENU3 appears only in its definition and menuButtons", () => {
  const src = readFileSync(new URL("../utils/messenger/bot.js", import.meta.url), "utf8");
  const from = src.indexOf("export function menuButtons");
  const fn = src.slice(from, src.indexOf("\n}\n", from) + 3);
  const rest = src.replace(fn, "").replace(/^export const MENU3 = .*$/m, "");
  assert.ok(fn.includes("MENU3"));
  assert.doesNotMatch(rest, /MENU3/);
  const raw = [
    stepRaw({ ...G, greeted: false }, pb("GET_STARTED"), ctx()).replies[0], stepRaw(G, txt("hi"), ctx()).replies[0], stepRaw(G, pb("RESTART"), ctx()).replies[0],
    stepRaw(G, txt("zzz qqq"), ctx()).replies[0], stepRaw(G, pb("MENU"), ctx()).replies[0], stepRaw(G, pb("CANCEL_DRAFT"), ctx()).replies[0],
    busyReplies()[0], ordersSummaryReplies([{ title: "A", order: null }], {})[0]
  ];
  for (const r of raw) {
    assert.ok(r.menu && !r.quick_replies, JSON.stringify(r));
    assert.deepEqual(payloads(renderReplies([r], show, ctx())[0]).includes("PENDING_ORDERS"), true);
    assert.deepEqual(payloads(renderReplies([r], hide, ctx())[0]).slice(0, 3), ["BUY", "LIST", "ADMIN"]);
  }
});

// ======== U7: carousel ========
test("UX-36 no sellable course: exact sentence + ADMIN + MENU, no template", () => {
  const m = step(G, pb("LIST"), ctx({ courses: [] })).replies;
  assert.equal(m.length, 1);
  assert.equal(m[0].text, "Hiện chưa có khóa nào mở đăng ký qua Messenger.");
  assert.deepEqual(payloads(m[0]), ["ADMIN", "MENU"]);
  assert.ok(!m[0].attachment);
});

test("UX-37 one course: one card with title, subtitle (price + short description) and 2 buttons; no swipe sentence", () => {
  const out = step(G, pb("LIST"), ctx({ courses: [A] })).replies;
  assert.equal(out.length, 1);
  const [e] = elements(out[0]);
  assert.deepEqual([e.title, e.subtitle, e.image_url], ["Khóa A", "Học phí: 100.000đ · Mô tả A", "https://img.example/a.jpg"]);
  assert.deepEqual(e.buttons, [{ type: "postback", title: "Xem chi tiết", payload: "DETAIL:khoa-a" }, { type: "postback", title: "Đăng ký", payload: "BUY:khoa-a" }]); // P2-5: details inside Messenger
  const noUrl = elements(step(G, pb("LIST"), ctx({ courses: [A], commerceUrl: "" })).replies[0])[0];
  assert.deepEqual(noUrl.buttons.map((b) => b.title), ["Xem chi tiết", "Đăng ký"]);
  assert.equal(elements(step(G, pb("LIST"), ctx({ courses: [B] })).replies[0])[0].subtitle, "Học phí: 200.000đ · Dòng 1 Dòng 2", "description, newlines removed");
});

test("UX-38 three courses: swipe sentence, 3 cards, quick replies MENU + ADMIN", () => {
  const out = step(G, pb("LIST"), ctx({ courses: manyCourses(3) })).replies;
  assert.equal(out[0].text, "Có 3 khóa đang mở. Vuốt ngang để xem thêm →");
  assert.equal(elements(out[1]).length, 3);
  assert.deepEqual(payloads(out[1]), ["MENU", "ADMIN"]);
});

// fake courses DB for loadCourses
const crow = (slug, extra = {}, raw = {}) => ({ slug, title: slug.toUpperCase(), price: "1", active: true, delivery_mode: "lms", image_url: "https://i.example/x.png", sort_order: null, raw_data: { messengerSale: true, bankAccount: "9", ...raw }, ...extra });
const coursesDb = (rows) => { const q = { select: () => q, eq: () => q, in: () => q, then: (res) => res({ data: rows, error: null }) }; return { from: () => q }; };

test("UX-39 six courses: featured first, then sort_order (empty last), then name", async () => {
  const rows = [crow("a"), crow("b", { sort_order: 2 }), crow("c", { sort_order: 1 }), crow("d", { sort_order: 1 }), crow("e", {}, { messengerFeatured: true }), crow("f")];
  const list = await loadCourses({}, coursesDb(rows));
  assert.deepEqual(list.map((c) => c.slug), ["e", "c", "d", "b", "a", "f"]);
  assert.deepEqual(list.map((c) => c.sortOrder), [null, 1, 1, 2, null, null]);
  const out = step(G, pb("LIST"), ctx({ courses: list })).replies;
  assert.deepEqual(elements(out[1]).map((e) => e.title), ["E", "C", "D", "B", "A", "F"]);
});

test("UX-40 ten courses: 10 cards on one page, no 'Xem tiếp'", () => {
  const out = step(G, pb("LIST"), ctx({ courses: manyCourses(10) })).replies;
  assert.equal(elements(out.at(-1)).length, 10);
  assert.ok(!payloads(out.at(-1)).some((p) => p.startsWith("LIST:")));
});

test("UX-41 11 and 25 courses paginate 9 per page; bad page numbers do not throw", () => {
  const page = (n, p) => step(G, pb(`LIST:${p}`), ctx({ courses: manyCourses(n) })).replies.at(-1);
  assert.deepEqual([elements(page(11, 1)).length, payloads(page(11, 1)).slice(2)], [9, ["LIST:2"]]);
  assert.deepEqual([elements(page(11, 2)).length, payloads(page(11, 2)).slice(2)], [2, ["LIST:1"]]);
  assert.deepEqual([elements(page(25, 2)).length, payloads(page(25, 2)).slice(2)], [9, ["LIST:1", "LIST:3"]]);
  assert.deepEqual([elements(page(25, 3)).length, payloads(page(25, 3)).slice(2)], [7, ["LIST:2"]]);
  for (const bad of ["0", "-1", "abc", ""]) assert.equal(elements(page(25, bad))[0].title, "Khóa số 0", `page ${bad} -> 1`);
  assert.equal(elements(page(25, 99)).at(-1).title, "Khóa số 24", "too big -> last page");
  assert.equal(step(G, pb("LIST"), ctx({ courses: manyCourses(25) })).replies[0].text, "Có 25 khóa đang mở. Vuốt ngang để xem thêm →");
});

test("UX-42 long title cut to 80 with an ellipsis; long price/description keep subtitle <= 80; image only when https", () => {
  const long = { ...A, title: "T".repeat(120), price: "9".repeat(60), subtitle: "d".repeat(100), imageUrl: "http://img.example/a.jpg" };
  const [e] = elements(step(G, pb("LIST"), ctx({ courses: [long] })).replies[0]);
  assert.equal(e.title.length, 80);
  assert.ok(e.title.endsWith("…"));
  assert.ok(e.subtitle.length <= 80);
  assert.ok(!("image_url" in e));
  assert.ok(!("image_url" in elements(step(G, pb("LIST"), ctx({ courses: [{ ...A, imageUrl: "" }] })).replies[0])[0]));
  assert.equal(elements(step(G, pb("LIST"), ctx({ courses: [{ ...A, title: "x".repeat(80) }] })).replies[0])[0].title, "x".repeat(80), "exactly 80: no ellipsis");
});

test("UX-43 courses that cannot be sold never appear on any page", async () => {
  const rows = [crow("ok"), crow("off", {}, { messengerSale: false }), crow("tg", { delivery_mode: "telegram" }), crow("paused", {}, { salePaused: true }),
    crow("noprice", { price: "" }), crow("nobank", {}, { bankAccount: "" }), crow("inactive", { active: false })];
  const list = await loadCourses({}, coursesDb(rows));
  assert.deepEqual(list.map((c) => c.slug), ["ok"]);
  const text = JSON.stringify(step(G, pb("LIST"), ctx({ courses: list })).replies);
  for (const bad of ["off", "tg", "paused", "noprice", "nobank", "inactive"]) assert.ok(!text.includes(`"BUY:${bad}"`), bad);
});

test("UX-44 course A with a pending order: card says so with 'Đơn của tôi'; an old BUY:A button still says 'already ordered'", async () => {
  const h = harness({ rows: [ord("oA", "khoa-a", { title: "Khóa A" })], statuses: { oA: { status: "Chờ duyệt" } } });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }] });
  const els = elements(lastOf(await h.press("LIST")));
  const a = els.find((e) => e.title === "Khóa A");
  const b = els.find((e) => e.title === "Khóa B");
  assert.equal(a.subtitle, "Bạn đã có đơn chờ duyệt");
  assert.deepEqual(a.buttons.at(-1), { type: "postback", title: "Đơn của tôi", payload: "PENDING_ORDERS" });
  assert.equal(b.buttons.at(-1).payload, "BUY:khoa_b");
  assert.equal(lastOf(await h.press("BUY:khoa-a")).text, "Bạn đã có đơn khóa này đang chờ Admin xác nhận.");
  assert.equal(h.orders.length, 0);
});

test("UX-45 DB error while building cards: every card shows 'Đăng ký'; BUY:A is still blocked (I1)", async () => {
  const h = harness({ dbOpts: { fail: true }, statuses: { oA: { status: "Chờ duyệt" } } });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }] });
  const els = elements(lastOf(await h.press("LIST")));
  assert.ok(els.every((e) => e.buttons.at(-1).title === "Đăng ký"));
  assert.equal(lastOf(await h.press("BUY:khoa-a")).text, "Bạn đã có đơn khóa này đang chờ Admin xác nhận.");
  assert.equal((await h.state()).course, null);
});

test("UX-46 Meta limits: <= 3 buttons per card, <= 10 cards, <= 13 quick replies, quick-reply and button titles <= 20", () => {
  const all = sweep();
  assert.ok(all.some((m) => m.attachment) && all.some((m) => m.quick_replies));
  for (const m of all) checkLimits(m);
});

// ======== rollback compatibility ========
test("UX-47 new state (draftMisses) survives normalizeState; the new payloads create no order and do not throw", async () => {
  const st = { ...emptyState(), greeted: true, course: "khoa_b", draftMisses: 1, orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA" };
  assert.deepEqual(normalizeState(st), st);
  assert.equal(emptyState().draftMisses, 0);
  const h = harness({ statuses: { oA: { status: "Chờ duyệt" } } });
  await h.seed(st);
  for (const p of ["LIST_OTHER", "CANCEL_DRAFT", "PENDING_ORDERS", "LIST:2", "CONTINUE_DRAFT"]) await h.press(p);
  assert.equal(h.orders.length, 0);
  assert.deepEqual((await h.state()).orders, [{ id: "oA", slug: "khoa-a" }]);
});

test("UX-48 LIST_OTHER pages keep the exclusion: page 2 never shows a course with a pending order", async () => {
  const courses = manyCourses(12);
  const h = harness({ courses, statuses: { o1: { status: "Chờ duyệt" } } });
  await h.seed({ orders: [{ id: "o1", slug: "c11" }] });
  const p1 = lastOf(await h.press("LIST_OTHER"));
  assert.ok(payloads(p1).includes("LIST_OTHER:2"), "next page stays in LIST_OTHER");
  const p2 = lastOf(await h.press("LIST_OTHER:2"));
  const shown = [...elements(p1), ...elements(p2)].map((e) => e.buttons.at(-1).payload);
  assert.equal(shown.length, 11);
  assert.ok(!shown.includes("BUY:c11"), "excluded course absent on every page");
  assert.ok(payloads(p2).includes("LIST_OTHER:1"));
  for (const bad of ["LIST_OTHER:abc", "LIST_OTHER:99", "LIST_OTHER:-1"]) assert.ok(elements(lastOf(await h.press(bad))).length > 0, bad);
  assert.equal(writes(h.db).length, 0);
});
