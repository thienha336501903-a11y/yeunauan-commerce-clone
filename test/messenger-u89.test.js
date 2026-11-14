// Messenger V2 U8 (back after a gap with a draft) + U9 (change course any time). U89-47..U89-74 = tests 47-74 of CLAUDE_MESSENGER_V2_UX_FIX_20261109.md.
import test from "node:test";
import assert from "node:assert/strict";
import { step, emptyState, normalizeState, PAUSE_MS, openCourse, switchAsk, paymentInfo } from "../utils/messenger/bot.js";
import { MessengerConversation, loadPendingOrders } from "../cloudflare/commerce-worker/src/messenger.js";

const PSID = "1234567890123";
const PAGE = "555";
const T0 = 1_800_000_000_000;
const H12 = 12 * 3600 * 1000;
const A = { slug: "khoa-a", title: "Khóa A", price: "100.000đ", subtitle: "", description: "", bankName: "VCB", bankAccount: "0123", bankOwner: "X", transferNote: "A", qrImageUrl: "", imageUrl: "", featured: false };
const B = { slug: "khoa_b", title: "Khóa B", price: "200.000đ", subtitle: "", description: "", bankName: "VCB", bankAccount: "0456", bankOwner: "X", transferNote: "B", qrImageUrl: "", imageUrl: "", featured: true };
const COURSES = [B, A];
const ctx = (extra = {}) => ({ now: T0, courses: COURSES, ticketsEnabled: true, faq: [], activeTicket: null, commerceUrl: "https://shop.example", ...extra });
// The DO answers a checkCourse action from the DB; with no order found it opens the draft, or asks to switch. Same here, without a DB.
const settle = (out, c = ctx()) => {
  const a = out.action;
  if (a?.type !== "checkCourse") return out;
  const course = c.courses.find((x) => x.slug === a.slug);
  if (a.ask && out.state.course && out.state.course !== a.slug) return { ...out, replies: [...out.replies, ...switchAsk(out.state, course, c)] };
  const r = openCourse(a.ref ? { ...out.state, ref: a.ref } : out.state, course, c);
  return { ...out, state: r.state, replies: [...out.replies, ...r.replies] };
};
const txt = (text, payload) => ({ kind: "text", text, ...(payload ? { payload } : {}) });
const pb = (payload) => ({ kind: "postback", payload });
const G = { ...emptyState(), greeted: true };
const payloads = (m) => [...(m.attachment?.payload?.buttons || []), ...(m.quick_replies || [])].map((q) => q.payload);
const textOf = (m) => m.text ?? m.attachment?.payload?.text;
const elements = (m) => m.attachment.payload.elements;
const ASK_AB = "Bạn đang đăng ký dở khóa Khóa A. Bạn muốn đổi sang khóa Khóa B không?";
const GMAIL_ASK = "Bạn gửi Gmail dùng để học (đăng nhập Google trên trang học), ví dụ ten@gmail.com nhé."; // G-LIVE-ux: T9
const BILL_ASK = "Bạn chụp ảnh bill chuyển khoản và gửi vào đây nhé.";
const BUSY = "Hệ thống đang bận, bạn thử lại sau ít phút nhé.";
const FEAT = "\n\nKhóa nổi bật: Khóa B."; // featured line after an ask:false text (Owner 14/11)

// ---- fake orders DB (records commands) ----
const ord = (id, slug, o = {}) => ({ id, status: o.status ?? "Chờ duyệt", course_slug: slug, course_title: slug.toUpperCase(), created_at: "2026-11-09T10:00:00Z", raw_data: { psid: PSID, pageId: PAGE } });
function ordersDb(rows, { fail = false } = {}) {
  const db = { log: [], rows, fail };
  db.from = () => {
    const q = { op: "select", eqs: [] };
    const api = {
      select: () => api, insert: () => { q.op = "insert"; return api; }, update: () => { q.op = "update"; return api; }, delete: () => { q.op = "delete"; return api; },
      eq: (k, v) => { q.eqs.push([k, v]); return api; }, or: () => api, order: () => api, limit: () => api, abortSignal: () => api,
      then: (res) => {
        db.log.push(q);
        if (db.fail) return res({ data: null, error: { message: "down" } });
        return res({ data: db.rows.filter((r) => r.status === "Chờ duyệt"), error: null });
      }
    };
    return api;
  };
  return db;
}
const writes = (db) => db.log.filter((q) => q.op !== "select");

// ---- DO harness with a controllable clock ----
function fakeStorage() {
  const map = new Map();
  return { map, async get(k) { return map.has(k) ? structuredClone(map.get(k)) : undefined; }, async put(k, v) { map.set(k, structuredClone(v)); } };
}
const IMG = "https://scontent.xx.fbcdn.net/v/bill.jpg";
function harness({ rows = [], courses = COURSES, statuses = {}, tickets = true, dbOpts = {}, env = {}, deps = {}, loadOrder } = {}) {
  const sent = [];
  const orders = [];
  const opened = [];
  const touched = [];
  const db = ordersDb(rows, dbOpts);
  const h = { sent, orders, opened, touched, db, t: T0, storage: fakeStorage() };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://graph.facebook.com/")) { sent.push(JSON.parse(init.body).message); return new Response("{}", { status: 200 }); }
    const res = new Response(new Uint8Array([0xff, 0xd8, 0xff, 1]), { status: 200, headers: { "content-type": "image/jpeg" } });
    Object.defineProperty(res, "url", { value: u });
    return res;
  };
  h.convo = new MessengerConversation({ storage: h.storage }, { META_PAGE_ACCESS_TOKEN: "t", META_APP_ID: "777", META_PAGE_ID: PAGE, ...(tickets ? { MESSENGER_TICKETS_ENABLED: "1" } : {}), ...env }, {
    fetchImpl, now: () => h.t, loadCourses: async () => courses, loadFaq: () => [],
    activeTicket: async () => h.active ?? null, openTicket: async (a) => { opened.push(a); return { ok: true }; }, touchTicket: async (id) => { touched.push(id); },
    loadOrder: loadOrder ?? (async (id) => statuses[id] ?? null),
    loadPendingOrders: (a) => loadPendingOrders(a, db),
    loadCourseOrders: async () => [],
    createBillOrder: async (input, opts) => { orders.push({ input, opts }); return { status: 200, body: { orderId: `new${orders.length}` } }; },
    ...deps
  });
  let n = 0;
  h.raw = async (mid, message, extra = {}) => { const before = sent.length; await h.convo.handle(PSID, { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, message: { mid, ...message }, ...extra }); return sent.slice(before); };
  h.say = (text) => h.raw(`m${++n}`, { text });
  h.press = (payload) => h.raw(`m${++n}`, { text: "x", quick_reply: { payload } });
  h.img = () => h.raw(`m${++n}`, { attachments: [{ type: "image", payload: { url: IMG } }] });
  h.echo = () => h.convo.handle(PSID, { sender: { id: PAGE }, recipient: { id: PSID }, timestamp: 1, message: { mid: `m${++n}`, is_echo: true, app_id: 777, text: "bot" } });
  h.seed = (state) => h.storage.put("s", { state: { ...emptyState(), greeted: true, ...state }, mids: [], hits: [] });
  h.state = async () => (await h.storage.get("s")).state;
  h.later = (ms) => { h.t += ms; };
  return h;
}
const last = (msgs) => msgs.at(-1);
// A draft at each step, last customer message at T0.
const DRAFTS = {
  gmail: { course: "khoa_b", lastInboundAt: T0 },
  confirm: { course: "khoa_b", gmail: "b@gmail.com", lastInboundAt: T0 },
  bill: { course: "khoa_b", gmail: "b@gmail.com", gmailOk: true, lastInboundAt: T0 }
};

// ======== U8 (removed by G-LIVE-ux O3: no "back after 12 hours" question any more) ========
test("U89-47 gap 11:59:59: stray text repeats the step as U4, no U8 question", async () => {
  const h = harness();
  await h.seed(DRAFTS.gmail);
  h.later(H12 - 1000);
  assert.equal(last(await h.say("blah blah")).text, GMAIL_ASK);
});

// G-LIVE-ux O3: U8 removed; after 12 hours a greeting is the normal menu (with the draft buttons), the draft is unchanged.
test("U89-48 gap exactly 12:00:00: no U8 question; 'hi' shows the menu with the draft buttons; the draft is unchanged", async () => {
  const h = harness();
  await h.seed(DRAFTS.confirm);
  h.later(H12);
  const m = last(await h.say("hi"));
  assert.ok(!textOf(m).includes("Trước đó"));
  assert.deepEqual(payloads(m), ["BUY:khoa_b", "LIST", "ADMIN", "CONTINUE_DRAFT", "CANCEL_DRAFT"]); // featured button (Owner 14/11)
  const s = await h.state();
  assert.deepEqual([s.course, s.gmail, s.gmailOk], ["khoa_b", "b@gmail.com", false]);
});

// G-LIVE-ux O3: U8 removed.
test("U89-49 gap over 12h at each step (Gmail / confirm / bill): no U8, the step handler answers", async () => {
  for (const d of Object.values(DRAFTS)) {
    const h = harness();
    await h.seed(d);
    h.later(H12 + 5000);
    assert.ok(!JSON.stringify(await h.say("alo shop có ở đó không")).includes("Trước đó"));
  }
});

test("U89-51 'Tiếp tục đăng ký' restores the exact step; gmailOk is kept; no order", async () => {
  const run = async (d) => { const h = harness(); await h.seed(d); h.later(H12); const out = await h.press("CONTINUE_DRAFT"); return { h, out }; };
  assert.equal(last((await run(DRAFTS.gmail)).out).text, GMAIL_ASK);
  assert.equal(last((await run(DRAFTS.confirm)).out).text, 'Đăng ký khóa "Khóa B" bằng Gmail b@gmail.com. Đúng không?');
  const { h, out } = await run(DRAFTS.bill);
  assert.match(out[0].text, /^Khoá: Khóa B\nHọc phí: 200\.000đ\nChuyển khoản: VCB \(X\)/); // G-LIVE-ux F-A10: the account number is its own message
  assert.equal(out[1].text, "0456");
  assert.equal(last(out).text, BILL_ASK);
  const s = await h.state();
  assert.deepEqual([s.gmail, s.gmailOk, s.course], ["b@gmail.com", true, "khoa_b"]);
  assert.equal(h.orders.length, 0);
});

test("U89-52 'Xem các khóa học' with a draft: carousel, draft kept, no DB write", async () => {
  const h = harness();
  await h.seed(DRAFTS.confirm);
  h.later(H12);
  await h.say("hi");
  const m = last(await h.press("LIST"));
  assert.equal(elements(m).length, 2);
  assert.equal((await h.state()).course, "khoa_b");
  assert.equal(writes(h.db).length, 0);
});

test("U89-53 'Chat với Admin' with a draft: Admin branch; draft and orders kept", async () => {
  const h = harness();
  await h.seed({ ...DRAFTS.confirm, orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA" });
  h.later(H12);
  await h.say("hi");
  assert.equal(last(await h.press("ADMIN")).text, "Bạn mô tả ngắn việc cần Admin hỗ trợ nhé."); // G-LIVE-ux F-A3
  const s = await h.state();
  assert.deepEqual([s.course, s.orders], ["khoa_b", [{ id: "oA", slug: "khoa-a" }]]);
});

// G-LIVE-ux O3: the sold-out check now runs on "Tiếp tục đăng ký" (it used to run on the U8 question).
test("U89-54 draft course no longer sold: sold-out sentence, draft dropped, orders kept, no DB write", async () => {
  const h = harness({ courses: [A] });
  await h.seed({ ...DRAFTS.confirm, orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA" });
  h.later(H12);
  const m = last(await h.press("CONTINUE_DRAFT"));
  assert.equal(m.text, "Khóa khoa_b hiện không còn mở đăng ký qua Messenger. Bạn muốn xem các khóa học khác đang mở bán hay trò chuyện với Admin ạ?");
  assert.deepEqual(payloads(m), ["LIST", "ADMIN"]);
  const s = await h.state();
  assert.deepEqual([s.course, s.gmail, s.gmailOk, s.orders], [null, null, false, [{ id: "oA", slug: "khoa-a" }]]);
  assert.equal(writes(h.db).length, 0);
  assert.equal(h.db.log.length, 0);
});

test("U89-54b sold-out sentence uses the title saved with the draft; old drafts without it fall back to the slug", async () => {
  const h = harness({ courses: [A] });
  await h.seed({ ...DRAFTS.confirm, courseTitle: "Khóa B – Làm bánh", courseTitleFor: "khoa_b" });
  h.later(H12);
  assert.match(last(await h.press("CONTINUE_DRAFT")).text, /^Khóa Khóa B – Làm bánh hiện không còn mở đăng ký/);
  assert.equal((await h.state()).courseTitle, null, "cleared with the draft");
});

test("U89-55 pending order, no draft, back after 12h: no U8; the menu has 'Đơn chờ duyệt'", async () => {
  const h = harness({ rows: [ord("oA", "khoa-a")] });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }], lastInboundAt: T0 });
  h.later(H12 + 1);
  const m = last(await h.say("hi"));
  assert.deepEqual(payloads(m), ["BUY:khoa_b", "LIST", "PENDING_ORDERS", "ADMIN"]); // featured button (Owner 14/11)
  assert.ok(!textOf(m).includes("Trước đó"));
});

test("U89-56 draft + pending order: the menu has 'Đơn chờ duyệt' and the draft buttons; DB error with an empty DO: 3 buttons + draft buttons, no 'no orders'", async () => {
  const h = harness({ rows: [ord("oA", "khoa-a")] });
  await h.seed({ ...DRAFTS.confirm, orders: [{ id: "oA", slug: "khoa-a" }] });
  h.later(H12);
  assert.deepEqual(payloads(last(await h.say("hi"))), ["BUY:khoa_b", "LIST", "PENDING_ORDERS", "ADMIN", "CONTINUE_DRAFT", "CANCEL_DRAFT"]); // G-LIVE-ux O3: no U8 variant // featured button (Owner 14/11)
  const bad = harness({ dbOpts: { fail: true } });
  await bad.seed(DRAFTS.confirm);
  bad.later(H12);
  const m = last(await bad.say("hi"));
  assert.deepEqual(payloads(m), ["BUY:khoa_b", "LIST", "ADMIN", "CONTINUE_DRAFT", "CANCEL_DRAFT"]); // featured button (Owner 14/11)
  assert.ok(!bad.sent.some((x) => (x.text || "").includes("không có đơn")));
});

test("U89-57 open ticket after 12h: silent (touchTicket), no U8; pendingAdmin after 12h: the text opens the ticket as before", async () => {
  const h = harness();
  h.active = { id: "t1" };
  await h.seed(DRAFTS.confirm);
  h.later(H12);
  assert.deepEqual(await h.say("hi"), []);
  assert.deepEqual(h.touched, ["t1"]);
  const p = harness();
  await p.seed({ ...DRAFTS.confirm, pendingAdmin: "support" });
  p.later(H12);
  await p.say("tôi cần hỗ trợ");
  assert.equal(p.opened.length, 1);
  assert.equal(p.opened[0].reason, "support");
  assert.ok(!p.sent.some((x) => (textOf(x) || "").includes("Trước đó")));
});

test("U89-58 bill after 12h with a complete draft creates exactly 1 order; an image with an incomplete draft repeats the step and creates no order", async () => {
  const h = harness();
  await h.seed(DRAFTS.bill);
  h.later(H12 + 1000);
  const out = await h.img();
  assert.equal(h.orders.length, 1);
  assert.equal(h.orders[0].input.course, "khoa_b");
  assert.match(last(out).text, /đã nhận bill/);
  const inc = harness();
  await inc.seed(DRAFTS.confirm);
  inc.later(H12 + 1000);
  assert.equal(textOf(last(await inc.img())), 'Đăng ký khóa "Khóa B" bằng Gmail b@gmail.com. Đúng không?'); // G-LIVE-ux O3: no U8
  assert.equal(inc.orders.length, 0);
});

test("U89-59 duplicate mid after 12h: handled once, the mark moves once", async () => {
  const h = harness();
  await h.seed(DRAFTS.gmail);
  h.later(H12);
  const first = await h.raw("dup1", { text: "hi" });
  assert.ok(first.length > 0);
  const mark = (await h.state()).lastInboundAt;
  assert.equal(mark, h.t);
  h.later(H12);
  assert.deepEqual(await h.raw("dup1", { text: "hi" }), []);
  assert.equal((await h.state()).lastInboundAt, mark);
});

test("U89-60 old state without lastInboundAt: no U8, the mark is written; an echo does not move it", async () => {
  const h = harness();
  await h.seed({ course: "khoa_b" });
  h.later(100 * H12);
  const m = last(await h.say("hi"));
  assert.ok(!textOf(m).includes("Trước đó"));
  assert.equal((await h.state()).lastInboundAt, h.t);
  const mark = h.t;
  h.later(5000);
  await h.echo();
  assert.equal((await h.state()).lastInboundAt, mark);
});

// G-LIVE-ux O3: an old "Đúng" button pressed after a long gap just works (no U8 in the way).
test("U89-61 old 'Đúng' (GMAIL_OK) pressed after 12h: the transfer details follow", async () => {
  const h = harness();
  await h.seed(DRAFTS.confirm);
  h.later(H12);
  const out = await h.press("GMAIL_OK");
  assert.ok(!JSON.stringify(out).includes("Trước đó"));
  assert.ok(JSON.stringify(out).includes("0456"));
  assert.equal((await h.state()).gmailOk, true);
});

test("U89-62 tickets off: no U8 (old behaviour)", async () => {
  const h = harness({ tickets: false });
  await h.seed(DRAFTS.gmail);
  h.later(100 * H12);
  const out = await h.say("hello");
  assert.ok(!JSON.stringify(out).includes("Trước đó"));
  assert.equal(last(out).text, GMAIL_ASK);
});

// G-LIVE-ux O3: MESSENGER_RESUME_GAP_MS is gone; setting it changes nothing.
test("U89-63 MESSENGER_RESUME_GAP_MS is ignored: 2 minutes later a stray text is still the normal step", async () => {
  assert.equal(PAUSE_MS, H12); // PAUSE_MS stays for the tickets-off pause and P0-2
  const h = harness({ env: { MESSENGER_RESUME_GAP_MS: "120000" } });
  await h.seed(DRAFTS.gmail);
  h.later(120000);
  assert.equal(last(await h.say("blah")).text, GMAIL_ASK);
});

test("U89-64 rollback: state with lastInboundAt survives normalizeState; SWITCH / CHANGE_COURSE create no order and do not throw", async () => {
  const st = { ...emptyState(), greeted: true, course: "khoa_b", lastInboundAt: T0, orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA" };
  assert.deepEqual(normalizeState(st), st);
  assert.equal(emptyState().lastInboundAt, 0);
  const h = harness({ statuses: { oA: { status: "Chờ duyệt" } } });
  await h.seed(st);
  for (const p of ["SWITCH:khoa-zzz", "CHANGE_COURSE", "SWITCH:khoa_b"]) await h.press(p);
  assert.equal(h.orders.length, 0);
});

// ======== U9 ========
test("U89-65 'Đổi khóa học' on the card, Gmail ask, retry, confirm and bill step; titles <= 20, <= 13 quick replies", () => {
  const has = (m) => m.quick_replies.some((q) => q.payload === "CHANGE_COURSE");
  const card = settle(step(G, pb("BUY:khoa-a"), ctx())).replies;
  assert.deepEqual(elements(card[0])[0].buttons.at(-1), { type: "postback", title: "Đổi khóa học", payload: "CHANGE_COURSE" });
  assert.ok(has(card[1]), "Gmail ask");
  const msgs = [card[1], step({ ...G, course: "khoa-a", gmail: "a@gmail.com" }, pb("GMAIL_NO"), ctx()).replies[0],
    step({ ...G, course: "khoa-a" }, txt("a@gmail.com"), ctx()).replies.at(-1),
    paymentInfo(A, true).at(-1), // GMAIL_OK now goes through the DO check (checkPayment)
    step({ ...G, course: "khoa-a", gmail: "a@gmail.com", gmailOk: true }, txt("..."), ctx()).replies[0]];
  for (const m of msgs) {
    assert.ok(has(m), m.text);
    assert.ok(m.quick_replies.length <= 13);
    for (const q of m.quick_replies) if (q.content_type === "text") assert.ok(q.title.length <= 20, q.title);
  }
  const bill = msgs[3];
  assert.equal(bill.text, BILL_ASK);
  assert.deepEqual(payloads(bill), ["CHANGE_COURSE", "CANCEL_DRAFT", "ADMIN"]);
});

test("U89-66 CHANGE_COURSE: carousel without courses that have a pending/approved order; the draft stays", async () => {
  const h = harness({ statuses: { oA: { status: "Chờ duyệt" } } });
  await h.seed({ course: "khoa_b", orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA" });
  const m = last(await h.press("CHANGE_COURSE"));
  assert.deepEqual(elements(m).map((e) => e.buttons.at(-1).payload), ["BUY:khoa_b"]);
  assert.equal((await h.state()).course, "khoa_b");
  assert.equal(writes(h.db).length, 0);
});

test("U89-67 draft A, BUY:B asks before switching; the draft stays A", () => {
  const out = settle(step({ ...G, course: "khoa-a", gmail: "a@gmail.com" }, pb("BUY:khoa_b"), ctx()));
  assert.equal(out.replies[0].text, ASK_AB);
  assert.deepEqual(out.replies[0].quick_replies.map((q) => [q.title, q.payload]), [["Đổi sang khóa này", "SWITCH:khoa_b"], ["Tiếp tục khóa cũ", "CONTINUE_DRAFT"], ["Xem các khóa học", "LIST"]]);
  assert.deepEqual([out.state.course, out.state.gmail], ["khoa-a", "a@gmail.com"]);
});

test("U89-68 SWITCH:B opens the draft for B (card + Gmail ask); A's Gmail does not carry over", () => {
  const out = settle(step({ ...G, course: "khoa-a", gmail: "a@gmail.com", gmailOk: true }, pb("SWITCH:khoa_b"), ctx()));
  assert.deepEqual([out.state.course, out.state.gmail, out.state.gmailOk], ["khoa_b", null, false]);
  assert.equal(elements(out.replies[0])[0].title, "Khóa B");
  assert.equal(out.replies[1].text, GMAIL_ASK);
});

test("U89-69 'Tiếp tục khóa cũ' returns to A's step with A's Gmail intact", () => {
  const st = { ...G, course: "khoa-a", gmail: "a@gmail.com" };
  const asked = step(st, pb("BUY:khoa_b"), ctx());
  const out = step(asked.state, pb("CONTINUE_DRAFT"), ctx());
  assert.equal(out.replies[0].text, 'Đăng ký khóa "Khóa A" bằng Gmail a@gmail.com. Đúng không?');
  assert.equal(out.state.gmail, "a@gmail.com");
});

test("U89-70 choosing the very course that is open continues it without asking", () => {
  const out = step({ ...G, course: "khoa-a", gmail: "a@gmail.com" }, pb("BUY:khoa-a"), ctx());
  assert.equal(out.replies[0].text, 'Đăng ký khóa "Khóa A" bằng Gmail a@gmail.com. Đúng không?');
  assert.ok(!JSON.stringify(out.replies).includes("SWITCH:"));
});

test("U89-71 pending order A, register B: 1 new order for B, A untouched; SWITCH:A says 'already ordered' and opens no draft", async () => {
  const h = harness({ statuses: { oA: { status: "Chờ duyệt" } } });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA" });
  await h.press("BUY:khoa_b");
  await h.say("b@gmail.com");
  await h.press("GMAIL_OK");
  await h.img();
  assert.equal(h.orders.length, 1);
  assert.equal(h.orders[0].input.course, "khoa_b");
  assert.deepEqual((await h.state()).orders, [{ id: "oA", slug: "khoa-a" }, { id: "new1", slug: "khoa_b" }]);
  const m = last(await h.press("SWITCH:khoa-a"));
  assert.equal(m.text, "Bạn đã có đơn khóa này đang chờ Admin xác nhận.");
  assert.equal((await h.state()).course, null);
  assert.equal(h.orders.length, 1);
});

test("U89-72 SWITCH:B when B is no longer sold: sentence + carousel; draft A kept", async () => {
  const h = harness({ courses: [A] });
  await h.seed({ course: "khoa-a", gmail: "a@gmail.com" });
  const out = await h.press("SWITCH:khoa_b");
  assert.match(out[0].text, /^Khóa này hiện chưa mở đăng ký\./);
  assert.ok(out.some((m) => m.attachment));
  const s = await h.state();
  assert.deepEqual([s.course, s.gmail], ["khoa-a", "a@gmail.com"]);
});

test("U89-73 referral, 'Đúng' (U5) and a typed course name while another draft is open all ask the same question", () => {
  const st = { ...G, course: "khoa-a", gmail: "a@gmail.com" };
  const ref = settle(step(st, { kind: "referral", ref: "c__khoa_b" }, ctx()));
  assert.equal(ref.replies[0].text, ASK_AB);
  assert.equal(ref.state.ref, null, "the campaign ref is not stored before SWITCH");
  assert.equal(ref.state.course, "khoa-a");
  const yes = settle(step(st, txt("Đúng", "BUY:khoa_b"), ctx()));
  assert.equal(yes.replies[0].text, ASK_AB);
  const typed = settle(step(st, txt("Khóa B"), ctx()));
  assert.equal(typed.replies[0].text, ASK_AB);
  assert.equal(typed.state.course, "khoa-a");
  const free = settle(step({ ...st, draftMisses: 1 }, txt("cho mình hỏi khóa b"), ctx()));
  assert.equal(free.replies[0].text, ASK_AB);
});

test("U89-74 DB error on the duplicate check while switching: busy message, draft unchanged, no order", async () => {
  const h = harness({ loadOrder: async () => { throw new Error("db down"); } });
  await h.seed({ course: "khoa_b", gmail: "b@gmail.com", orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA" });
  for (const p of ["BUY:khoa-a", "SWITCH:khoa-a"]) {
    assert.equal(textOf(last(await h.press(p))), BUSY + FEAT); // featured button (Owner 14/11)
    const s = await h.state();
    assert.deepEqual([s.course, s.gmail], ["khoa_b", "b@gmail.com"]);
  }
  assert.equal(h.orders.length, 0);
});

test("U89-75 review fixes: stale courseTitle of another slug is ignored; typed 'gặp người' / HUMAN after 12h open the ticket, not U8", async () => {
  const h = harness({ courses: [A] });
  await h.seed({ ...DRAFTS.confirm, courseTitle: "Khóa A cũ", courseTitleFor: "khoa-a" });
  h.later(H12);
  assert.match(last(await h.press("CONTINUE_DRAFT")).text, /^Khóa khoa_b hiện không còn/); // G-LIVE-ux O3: checked on CONTINUE_DRAFT
  for (const ev of [(x) => x.say("cho mình gặp người thật"), (x) => x.press("HUMAN")]) {
    const g = harness();
    await g.seed(DRAFTS.confirm);
    g.later(H12 + 1);
    await ev(g);
    assert.equal(g.opened.length, 1, "ticket opened");
    assert.equal(g.opened[0].reason, "human");
    assert.equal((await g.state()).course, "khoa_b", "draft kept");
  }
});

test("U89-76 review fixes: failed bill upload after 12h keeps the time mark (next text is not U8)", async () => {
  const h = harness({ deps: { createBillOrder: async () => ({ status: 500, body: { code: "x" } }) } });
  await h.seed(DRAFTS.bill);
  h.later(H12 + 1000);
  assert.match(last(await h.img()).text, /chưa tạo được đơn/); // Gate 1: a server error is not an image problem
  h.later(10_000);
  assert.ok(!JSON.stringify(await h.say("sao vậy")).includes("Trước đó"));
  assert.equal(h.orders.length, 0);
});

test("U89-77 review fixes: a draft opened while the duplicate lookup ran is not replaced without asking (I11)", async () => {
  let h;
  h = harness({ loadOrder: async () => {
    const cur = await h.storage.get("s");
    await h.storage.put("s", { ...cur, state: { ...cur.state, course: "khoa-a", gmail: "a@gmail.com" } });
    return { status: "Từ chối" };
  } });
  await h.seed({ orders: [{ id: "oB", slug: "khoa_b" }], orderId: "oB", lastInboundAt: T0 });
  const out = await h.press("BUY:khoa_b");
  assert.ok(payloads(last(out)).includes("SWITCH:khoa_b"), "asks before replacing");
  const s = await h.state();
  assert.deepEqual([s.course, s.gmail], ["khoa-a", "a@gmail.com"]);
  assert.equal(h.orders.length, 0);
});
