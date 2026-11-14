// G-V2-fix: P0-1 (duplicate orders: DB check before a draft, before the transfer details, before a bill), P0-2 (ticket lookup
// failed = unknown), P1-3 (campaign ref), P1-4 (loadOrder timeout), P2-5 (course details inside Messenger).
// FIX-78..FIX-95 follow tests 78-95 of CLAUDE_GATE_V2_FIX_20261110.md; FIX-96.. are the extra tests of its review section.
import test from "node:test";
import assert from "node:assert/strict";
import { step, stepRaw, emptyState, normalizeState, UNVERIFIED_TEXT } from "../utils/messenger/bot.js";
import { MessengerConversation, loadPendingOrders, loadCourseOrders, loadOrder } from "../cloudflare/commerce-worker/src/messenger.js";

const PSID = "1234567890123";
const OTHER_PSID = "9999999999999";
const PAGE = "555";
const T0 = 1_800_000_000_000;
const H12 = 12 * 3600 * 1000;
const A = { slug: "khoa-a", title: "Khóa A", price: "100.000đ", subtitle: "", description: "", bankName: "VCB", bankAccount: "0123", bankOwner: "X", transferNote: "A", qrImageUrl: "", imageUrl: "", featured: false };
const B = { slug: "khoa_b", title: "Khóa B", price: "200.000đ", subtitle: "Phụ đề B", description: "Dòng 1\nDòng 2", bankName: "VCB", bankAccount: "0456", bankOwner: "X", transferNote: "B", qrImageUrl: "", imageUrl: "https://img.example/b.jpg", featured: true };
const COURSES = [B, A];
const ctx = (extra = {}) => ({ now: T0, courses: COURSES, ticketsEnabled: true, faq: [], activeTicket: null, commerceUrl: "https://shop.example", ...extra });
const G = { ...emptyState(), greeted: true };
const payloads = (m) => [...(m.attachment?.payload?.buttons || []), ...(m.quick_replies || [])].map((q) => q.payload);
const textOf = (m) => m.text ?? m.attachment?.payload?.text;
const last = (msgs) => msgs.at(-1);
const DUP_PENDING = "Bạn đã có đơn khóa này đang chờ Admin xác nhận.";
const BUSY = "Hệ thống đang bận, bạn thử lại sau ít phút nhé.";
const FEAT = "\n\nKhóa nổi bật: Khóa B."; // featured line after an ask:false text (Owner 14/11)
const ASK_AB = "Bạn đang đăng ký dở khóa Khóa A. Bạn muốn đổi sang khóa Khóa B không?";

// ---- fake orders DB: filters like PostgREST would, records every command ----
const ord = (id, slug, o = {}) => ({
  id, status: o.status ?? "Chờ duyệt", course_slug: slug, course_title: slug.toUpperCase(), customer_email: "a@gmail.com", created_at: "2026-11-09T10:00:00Z",
  raw_data: { psid: o.psid ?? PSID, ...(o.pageId === null ? {} : { pageId: o.pageId ?? PAGE }) }
});
function ordersDb(rows, { fail = false, hang = false, lax = false } = {}) {
  const db = { log: [], rows, fail, hang, lax };
  db.from = () => {
    const q = { op: "select", eqs: [], ins: [], or: null, single: false };
    const api = {
      select: () => api, insert: () => { q.op = "insert"; return api; }, update: () => { q.op = "update"; return api; }, delete: () => { q.op = "delete"; return api; },
      eq: (k, v) => { q.eqs.push([k, v]); return api; }, in: (k, v) => { q.ins.push([k, v]); return api; }, or: (c) => { q.or = c; return api; },
      order: () => api, limit: () => api, abortSignal: (s) => { q.signal = s; return api; }, maybeSingle: () => { q.single = true; return api; },
      then: (res, rej) => {
        db.log.push(q);
        if (db.hang) { q.signal?.addEventListener("abort", () => rej(new Error("aborted"))); return; }
        if (db.fail) return res({ data: null, error: { message: "down" } });
        const pageEq = /raw_data->>pageId\.eq\.(\d+)/.exec(q.or || "")?.[1];
        const key = { status: (r) => r.status, course_slug: (r) => r.course_slug, "raw_data->>psid": (r) => r.raw_data.psid, id: (r) => r.id };
        const hit = db.rows.filter((r) => db.lax || (q.eqs.every(([k, v]) => !key[k] || key[k](r) === v) && q.ins.every(([k, v]) => v.includes(r[k]))
          && (q.or === null || r.raw_data.pageId === pageEq || r.raw_data.pageId == null)));
        return res({ data: q.single ? hit[0] || null : hit, error: null });
      }
    };
    return api;
  };
  return db;
}
const writes = (db) => db.log.filter((q) => q.op !== "select");

// ---- Durable Object harness with a clock ----
function fakeStorage() {
  const map = new Map();
  return { map, async get(k) { return map.has(k) ? structuredClone(map.get(k)) : undefined; }, async put(k, v) { map.set(k, structuredClone(v)); } };
}
const IMG = "https://scontent.xx.fbcdn.net/v/bill.jpg";
function harness({ rows = [], courses = COURSES, statuses = {}, tickets = true, dbOpts = {}, env = {}, deps = {} } = {}) {
  const sent = [];
  const orders = [];
  const opened = [];
  const db = ordersDb(rows, dbOpts);
  const h = { sent, orders, opened, db, t: T0, downloads: 0, storage: fakeStorage(), active: null };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://graph.facebook.com/")) { sent.push(JSON.parse(init.body).message); return new Response("{}", { status: 200 }); }
    h.downloads++;
    const res = new Response(new Uint8Array([0xff, 0xd8, 0xff, 1]), { status: 200, headers: { "content-type": "image/jpeg" } });
    Object.defineProperty(res, "url", { value: u });
    return res;
  };
  h.convo = new MessengerConversation({ storage: h.storage }, { META_PAGE_ACCESS_TOKEN: "t", META_APP_ID: "777", META_PAGE_ID: PAGE, ...(tickets ? { MESSENGER_TICKETS_ENABLED: "1" } : {}), ...env }, {
    fetchImpl, now: () => h.t, loadCourses: async () => courses, loadFaq: () => [],
    activeTicket: async () => { if (h.activeFn) return h.activeFn(); return h.active; }, openTicket: async (a) => { opened.push(a); return { ok: true }; }, touchTicket: async () => {},
    loadOrder: async (id) => statuses[id] ?? null,
    loadPendingOrders: (a) => loadPendingOrders(a, db),
    // G-LIVE-ux F-A1: the orders view reads through loadMyOrders (pending-only fake DB here).
    loadMyOrders: async (a) => (await loadPendingOrders(a, db)).map((r) => ({ ...r, status: "Chờ duyệt", email: "" })),
    loadCourseOrders: (a) => loadCourseOrders(a, db),
    createBillOrder: async (input, opts) => { orders.push({ input, opts }); return { status: 200, body: { orderId: `new${orders.length}` } }; },
    ...deps
  });
  let n = 0;
  h.raw = async (mid, message) => { const before = sent.length; await h.convo.handle(PSID, { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, message: { mid, ...message } }); return sent.slice(before); };
  h.say = (text) => h.raw(`m${++n}`, { text });
  h.press = (payload) => h.raw(`m${++n}`, { text: "x", quick_reply: { payload } });
  h.img = () => h.raw(`m${++n}`, { attachments: [{ type: "image", payload: { url: IMG } }] });
  h.referral = async (ref) => { const before = sent.length; await h.convo.handle(PSID, { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: ++n, referral: { ref } }); return sent.slice(before); };
  h.echo = (app) => h.convo.handle(PSID, { sender: { id: PAGE }, recipient: { id: PSID }, timestamp: 1, message: { mid: `m${++n}`, is_echo: true, app_id: app, text: "x" } });
  h.seed = (state) => h.storage.put("s", { state: { ...emptyState(), greeted: true, ...state }, mids: [], hits: [] });
  h.state = async () => (await h.storage.get("s")).state;
  h.later = (ms) => { h.t += ms; };
  h.ready = async (slug = "khoa-a", gmail = "a@gmail.com") => { await h.press(`BUY:${slug}`); await h.say(gmail); await h.press("GMAIL_OK"); };
  return h;
}

// ======== P0-1 ========
test("FIX-78 DO storage lost, DB has a pending order for A: BUY:A says so, the id is put back into orders, no new order", async () => {
  const h = harness({ rows: [ord("oA", "khoa-a")] });
  await h.seed({});
  assert.equal(last(await h.press("BUY:khoa-a")).text, DUP_PENDING);
  const s = await h.state();
  assert.deepEqual(s.orders, [{ id: "oA", slug: "khoa-a" }]);
  assert.equal(s.course, null);
  assert.equal(h.orders.length, 0);
});

test("FIX-79 order A cut out of a full DO (10 others): BUY:A is still blocked through the DB", async () => {
  const others = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, slug: `old${i}` }));
  const h = harness({ rows: [ord("oA", "khoa-a")] });
  await h.seed({ orders: others });
  assert.equal(last(await h.press("BUY:khoa-a")).text, DUP_PENDING);
  const s = await h.state();
  assert.equal(s.course, null);
  assert.deepEqual(s.orders, others, "no room: nothing is added");
});

test("FIX-80 order without pageId blocks (Admin sentence); other Page or other PSID does not count", async () => {
  const old = harness({ rows: [ord("oA", "khoa-a", { pageId: null })] });
  await old.seed({});
  assert.equal(last(await old.press("BUY:khoa-a")).text, UNVERIFIED_TEXT);
  assert.equal((await old.state()).course, null);
  for (const row of [ord("o1", "khoa-a", { pageId: "777" }), ord("o2", "khoa-a", { psid: OTHER_PSID })]) {
    for (const lax of [false, true]) {
      const h = harness({ rows: [row], dbOpts: { lax } });
      await h.seed({});
      await h.press("BUY:khoa-a");
      assert.equal((await h.state()).course, "khoa-a", `${row.id} lax=${lax}`);
    }
  }
});

test("FIX-81 a rejected order (Từ chối) in the DB does not block: the draft opens normally", async () => {
  const h = harness({ rows: [ord("oA", "khoa-a", { status: "Từ chối" })] });
  await h.seed({});
  const out = await h.press("BUY:khoa-a");
  assert.ok(out.some((m) => m.attachment), "course card");
  assert.equal((await h.state()).course, "khoa-a");
  const q = h.db.log[0];
  assert.deepEqual(q.ins, [["status", ["Chờ duyệt", "Đã duyệt"]]]);
  assert.deepEqual(q.eqs.filter(([k]) => k === "course_slug"), [["course_slug", "khoa-a"]]);
});

test("FIX-82 an order for the course appears between the draft and the bill: no order, no upload, one 'support' ticket, draft kept", async () => {
  const h = harness();
  await h.seed({});
  await h.ready();
  h.db.rows.push(ord("oA", "khoa-a"));
  const out = await h.img();
  assert.equal(h.orders.length, 0);
  assert.equal(h.downloads, 0, "nothing uploaded");
  assert.equal(last(out).text, "Mình đã nhận ảnh. Khóa này đã có đơn trước đó, Admin sẽ kiểm tra bill này và trả lời bạn.");
  assert.deepEqual(payloads(last(out)), ["ADMIN"]);
  assert.deepEqual(h.opened.map((o) => [o.reason, o.summary]), [["support", "Bill gửi lại cho khóa đã có đơn: khoa-a"]]);
  const s = await h.state();
  assert.deepEqual([s.course, s.gmail, s.gmailOk], ["khoa-a", "a@gmail.com", true]);
});

test("FIX-83 DB error at the draft check: busy, no draft; at the bill check: busy, no order, the lock is released", async () => {
  const a = harness({ dbOpts: { fail: true } });
  await a.seed({});
  const out = await a.press("BUY:khoa-a");
  assert.equal(last(out).text, BUSY);
  assert.ok(payloads(last(out)).includes("ADMIN"));
  assert.equal((await a.state()).course, null);
  const b = harness();
  await b.seed({ course: "khoa-a", gmail: "a@gmail.com", gmailOk: true });
  b.db.fail = true;
  assert.equal(last(await b.img()).text, BUSY);
  assert.equal(b.orders.length, 0);
  assert.equal(b.downloads, 0);
  assert.equal((await b.storage.get("s")).creatingAt, 0);
  assert.equal((await b.state()).course, "khoa-a");
  b.db.fail = false;
  await b.img();
  assert.equal(b.orders.length, 1, "the next bill goes through");
});

test("FIX-84 two bills one after the other create exactly one order", async () => {
  const h = harness();
  await h.seed({});
  await h.ready();
  await h.img();
  await h.img();
  assert.equal(h.orders.length, 1);
});

test("FIX-85 no network call between a storage.get and the put that follows it, in every flow", async () => {
  const log = [];
  const h = harness({ statuses: { oA: { status: "Chờ duyệt" } }, env: { MESSENGER_COURSE_SLUGS: "" } });
  for (const k of ["get", "put"]) { const f = h.storage[k].bind(h.storage); h.storage[k] = async (...a) => { log.push(k); return f(...a); }; }
  for (const k of ["loadCourses", "activeTicket", "loadCourseOrders", "loadPendingOrders", "loadOrder", "createBillOrder", "openTicket", "fetchImpl"]) {
    const f = h.convo.deps[k];
    h.convo.deps[k] = async (...a) => { log.push("net"); return f(...a); };
  }
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }] });
  await h.press("BUY:khoa_b");
  await h.say("b@gmail.com");
  await h.press("GMAIL_OK");
  await h.img();
  await h.press("PENDING_ORDERS");
  await h.say("hi");
  await h.press("LIST_OTHER");
  await h.press("BUY:khoa-a");
  await h.press("BUY:khoa_b");
  await h.press("SWITCH:khoa_b");
  await h.press("CHANGE_COURSE");
  h.activeFn = async () => { throw new Error("down"); };
  await h.say("hi");
  h.activeFn = null;
  await h.echo(1);
  let open = false;
  let net = false;
  let pairs = 0;
  for (const e of log) {
    if (e === "get") { open = true; net = false; } else if (e === "net") { if (open) net = true; } else if (open) { assert.equal(net, false, "network between get and put"); open = false; pairs++; }
  }
  assert.ok(pairs >= 12, `pairs=${pairs}`);
});

// ======== P0-2 ========
const down = async () => { throw new Error("db down"); };

test("FIX-86 ticket lookup fails and an Admin wrote within 12h: silence, no ticket, state kept", async () => {
  const h = harness();
  h.activeFn = down;
  await h.seed({ course: "khoa_b", gmail: "b@gmail.com", adminSeenAt: T0 - 3600 * 1000 });
  assert.deepEqual(await h.say("hi"), []);
  assert.deepEqual(await h.press("GMAIL_NO"), []);
  assert.equal(h.opened.length, 0);
  const s = await h.state();
  assert.deepEqual([s.course, s.gmail], ["khoa_b", "b@gmail.com"]);
});

test("FIX-87 ticket lookup fails, no recent Admin: one busy message (Admin button) per 10 minutes, no U8, draft kept", async () => {
  const h = harness();
  h.activeFn = down;
  await h.seed({ course: "khoa_b", lastInboundAt: T0 - 2 * H12 });
  const first = await h.say("hi");
  assert.equal(last(first).text, BUSY);
  assert.ok(payloads(last(first)).includes("ADMIN"));
  assert.ok(!JSON.stringify(first).includes("Trước đó"));
  h.later(5 * 60 * 1000);
  assert.deepEqual(await h.say("alo"), []);
  h.later(5 * 60 * 1000);
  assert.equal(last(await h.say("alo")).text, BUSY);
  assert.equal((await h.state()).course, "khoa_b");
  assert.equal(h.opened.length, 0);
});

test("FIX-88 a lookup timeout counts as unknown; an echo of the app does not set adminSeenAt, a human echo does", async () => {
  const h = harness({ deps: { lookupMs: 20 } });
  h.activeFn = () => new Promise(() => {});
  await h.seed({});
  assert.equal(last(await h.say("hi")).text, BUSY);
  const e = harness();
  await e.seed({});
  await e.echo(777);
  assert.equal((await e.state()).adminSeenAt, 0);
  assert.equal(e.opened.length, 0);
  e.later(1000);
  await e.echo(1);
  assert.equal((await e.state()).adminSeenAt, e.t);
  assert.equal(e.opened[0].reason, "admin_reply");
});

// ======== P1-3 ref ========
test("FIX-89 referral to a course whose old order was rejected: the new draft has the ref and the order carries it", async () => {
  const h = harness({ statuses: { oA: { status: "Từ chối" } } });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA" });
  await h.referral("c__khoa-a__fb1");
  assert.equal((await h.state()).course, "khoa-a");
  assert.equal((await h.state()).ref, "c__khoa-a__fb1");
  await h.say("a@gmail.com");
  await h.press("GMAIL_OK");
  await h.img();
  assert.equal(h.orders[0].opts.rawExtra.ref, "c__khoa-a__fb1");
});

test("FIX-90 referral while another draft is open: SWITCH uses its ref; CONTINUE_DRAFT drops it and the old order has no foreign ref", async () => {
  const h = harness();
  await h.seed({});
  await h.press("BUY:khoa-a");
  const out = await h.referral("c__khoa_b__fb2");
  assert.equal(last(out).text, ASK_AB);
  assert.deepEqual((await h.state()).switchRef, { slug: "khoa_b", ref: "c__khoa_b__fb2" });
  assert.equal((await h.state()).ref, null);
  await h.press("SWITCH:khoa_b");
  const s = await h.state();
  assert.deepEqual([s.course, s.ref, s.switchRef], ["khoa_b", "c__khoa_b__fb2", null]);
  const k = harness();
  await k.seed({});
  await k.press("BUY:khoa-a");
  await k.referral("c__khoa_b__fb2");
  await k.press("CONTINUE_DRAFT");
  assert.equal((await k.state()).switchRef, null);
  await k.say("a@gmail.com");
  await k.press("GMAIL_OK");
  await k.img();
  assert.equal(k.orders[0].input.course, "khoa-a");
  assert.equal("ref" in k.orders[0].opts.rawExtra, false);
});

// ======== P1-4 ========
test("FIX-91 loadOrder that hangs past the timeout: busy message, no draft, the DO still answers", async () => {
  const db = ordersDb([], { hang: true });
  await assert.rejects(loadOrder("oA", db, 30), /aborted/);
  assert.ok(db.log[0].signal, "an abort signal is passed");
  const h = harness({ deps: { loadOrder: (id) => loadOrder(id, db, 30) } });
  await h.seed({ orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA" });
  const out = await h.press("BUY:khoa-a");
  assert.equal(textOf(last(out)), BUSY + FEAT); // featured button (Owner 14/11)
  assert.equal((await h.state()).course, null);
});

// ======== P2-5 DETAIL ========
test("FIX-92 DETAIL:<slug> sends the details inside Messenger: image first, one text with name, price, subtitle, cut description, 3 buttons, no website link", async () => {
  const long = { ...B, description: `<p>${"x".repeat(1500)}</p>` };
  const h = harness({ courses: [long, A] });
  await h.seed({});
  const out = await h.press("DETAIL:khoa_b");
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].attachment, { type: "image", payload: { url: "https://img.example/b.jpg", is_reusable: true } });
  const m = out[1];
  assert.ok(m.text.startsWith("Khóa B\n\nHọc phí: 200.000đ\n\nPhụ đề B\n\n"));
  assert.ok(m.text.length <= 2000 && m.text.length < 700);
  assert.ok(m.text.endsWith("…"), "description cut");
  assert.deepEqual(m.quick_replies.map((q) => [q.title, q.payload]), [["Đăng ký", "BUY:khoa_b"], ["Xem các khóa học", "LIST"], ["Chat với Admin", "ADMIN"]]);
  assert.ok(!JSON.stringify(out).includes("/?course="));
});

test("FIX-93 DETAIL for an unknown / not sold slug: 'chưa mở đăng ký' + list; HTML and extra blank lines are cleaned; Meta limits hold", async () => {
  const h = harness();
  await h.seed({});
  for (const slug of ["khoa-zzz", "khoa-off"]) {
    const out = await h.press(`DETAIL:${slug}`);
    assert.match(out[0].text, /^Khóa này hiện chưa mở đăng ký\./);
    assert.ok(out.some((m) => m.attachment?.payload?.template_type === "generic"));
  }
  const html = harness({ courses: [{ ...A, description: "<p>Xin&nbsp;chào<br/>bạn</p>\n\n\n\n<b>Học</b>   nhanh", price: "100.000đ" }] });
  await html.seed({});
  const m = last(await html.press("DETAIL:khoa-a"));
  assert.ok(m.text.includes("Xin chào bạn\n\nHọc nhanh"), m.text);
  assert.ok(!/[<>]/.test(m.text));
  assert.ok(m.quick_replies.length <= 13 && m.quick_replies.every((q) => q.title.length <= 20));
  const huge = harness({ courses: [{ ...A, title: "T".repeat(300), subtitle: "s".repeat(500), description: "d".repeat(5000) }] });
  await huge.seed({});
  assert.ok(last(await huge.press("DETAIL:khoa-a")).text.length <= 2000);
});

test("FIX-94 carousel and course card have no web_url to /?course=; DETAIL postbacks instead; Admin offer still sends", async () => {
  const h = harness();
  await h.seed({});
  const list = last(await h.press("LIST"));
  for (const e of list.attachment.payload.elements) assert.deepEqual(e.buttons[0], { type: "postback", title: "Xem chi tiết", payload: `DETAIL:${e.buttons[1].payload.slice(4)}` });
  assert.ok(!JSON.stringify(list).includes("/?course="));
  const card = (await h.press("BUY:khoa-a")).find((m) => m.attachment);
  assert.deepEqual(card.attachment.payload.elements[0].buttons[0], { type: "postback", title: "Xem nội dung khóa", payload: "DETAIL:khoa-a" });
  const o = harness();
  const r = await o.convo.offer(PSID, "khoa-a");
  assert.deepEqual([r.status, r.body.ok, r.body.sent], [200, true, true]);
  assert.ok(!JSON.stringify(o.sent).includes("/?course="));
  assert.ok(o.sent[0].attachment);
  const off = step(G, { kind: "postback", payload: "BUY:khoa-a" }, ctx({ ticketsEnabled: false }));
  assert.equal(off.replies[0].attachment.payload.elements[0].buttons[0].type, "web_url", "tickets off keeps the web link");
});

test("FIX-95 old/new state compatibility: the new fields survive normalizeState; new payloads create no order and do not throw", async () => {
  const st = { ...emptyState(), greeted: true, course: "khoa_b", adminSeenAt: 5, ticketBusyAt: 6, switchRef: { slug: "khoa-a", ref: "c__khoa-a" }, orders: [{ id: "oA", slug: "khoa-a" }], orderId: "oA" };
  assert.deepEqual(normalizeState(st), st);
  assert.deepEqual([emptyState().adminSeenAt, emptyState().ticketBusyAt, emptyState().switchRef], [0, 0, null]);
  const { adminSeenAt, ticketBusyAt, switchRef, ...old } = st;
  const n = normalizeState(old);
  assert.deepEqual([n.adminSeenAt, n.ticketBusyAt, n.switchRef], [0, 0, null]);
  const h = harness({ statuses: { oA: { status: "Chờ duyệt" } }, rows: [ord("oA", "khoa-a")] });
  await h.seed(st);
  for (const p of ["DETAIL:khoa-a", "DETAIL:nope", "SWITCH:khoa-a", "SWITCH:khoa_b", "CHANGE_COURSE"]) await h.press(p);
  assert.equal(h.orders.length, 0);
});

// ======== review additions ========
test("FIX-96 an order without pageId is not healed into the DO; PENDING_ORDERS still gives the Admin sentence", async () => {
  const h = harness({ rows: [ord("oOld", "khoa-a", { pageId: null })] });
  await h.seed({});
  await h.press("BUY:khoa-a");
  assert.deepEqual((await h.state()).orders, []);
  assert.equal(last(await h.press("PENDING_ORDERS")).text, UNVERIFIED_TEXT);
});

test("FIX-97 approved order without pageId found through the DB: the sentence has no Gmail; a verified approved order shows it", async () => {
  const old = harness({ rows: [ord("o1", "khoa-a", { pageId: null, status: "Đã duyệt" })] });
  await old.seed({});
  const m = last(await old.press("BUY:khoa-a"));
  assert.equal(m.text, UNVERIFIED_TEXT);
  assert.ok(!JSON.stringify(old.sent).includes("@gmail.com"));
  const ok = harness({ rows: [ord("o2", "khoa-a", { status: "Đã duyệt" })] });
  await ok.seed({});
  assert.match(last(await ok.press("BUY:khoa-a")).text, /đã được duyệt/);
});

test("FIX-98 with tickets off the bill check still blocks: no order, no ticket, Admin button", async () => {
  const h = harness({ tickets: false });
  await h.seed({ course: "khoa-a", gmail: "a@gmail.com", gmailOk: true });
  h.db.rows.push(ord("oA", "khoa-a"));
  const out = await h.img();
  assert.equal(h.orders.length, 0);
  assert.equal(h.opened.length, 0);
  assert.deepEqual(payloads(last(out)), ["HUMAN"]);
  assert.equal((await h.state()).course, "khoa-a");
});

test("FIX-99 choosing a course returns a checkCourse action and changes nothing; an event during the lookup cannot be overwritten (I11)", async () => {
  const raw = stepRaw(G, { kind: "postback", payload: "BUY:khoa-a" }, ctx());
  assert.deepEqual(raw.action, { type: "checkCourse", slug: "khoa-a", ask: false, confirmed: false, ref: null });
  assert.equal(raw.state.course, null);
  assert.deepEqual(raw.replies, []);
  let injected = false;
  const h = harness();
  const inner = h.convo.deps.loadCourseOrders;
  h.convo.deps.loadCourseOrders = async (a) => {
    if (!injected) { injected = true; await h.press("BUY:khoa_b"); }
    return inner(a);
  };
  await h.seed({});
  const out = await h.press("BUY:khoa-a");
  assert.equal(last(out).text, "Bạn đang đăng ký dở khóa Khóa B. Bạn muốn đổi sang khóa Khóa A không?");
  assert.equal((await h.state()).course, "khoa_b", "the draft opened meanwhile is kept");
});

test("FIX-100 GMAIL_OK with an order in the DB: no transfer details, gmailOk stays false; DB error: busy", async () => {
  const h = harness();
  await h.seed({});
  await h.press("BUY:khoa-a");
  await h.say("a@gmail.com");
  h.db.rows.push(ord("oA", "khoa-a"));
  const out = await h.press("GMAIL_OK");
  assert.equal(last(out).text, DUP_PENDING);
  assert.ok(!JSON.stringify(out).includes("0123"));
  assert.equal((await h.state()).gmailOk, false);
  const e = harness();
  await e.seed({});
  await e.press("BUY:khoa-a");
  await e.say("a@gmail.com");
  e.db.fail = true;
  const bad = await e.press("GMAIL_OK");
  assert.equal(last(bad).text, BUSY);
  assert.ok(!JSON.stringify(bad).includes("0123"));
  assert.equal((await e.state()).gmailOk, false);
});

test("FIX-101 empty META_PAGE_ID: every new check fails closed (no draft, no transfer details, no order) and runs no query", async () => {
  const h = harness({ env: { META_PAGE_ID: "" } });
  await h.seed({});
  assert.equal(last(await h.press("BUY:khoa-a")).text, BUSY);
  assert.equal((await h.state()).course, null);
  await h.seed({ course: "khoa-a", gmail: "a@gmail.com" });
  assert.equal(last(await h.press("GMAIL_OK")).text, BUSY);
  await h.seed({ course: "khoa-a", gmail: "a@gmail.com", gmailOk: true });
  assert.equal(last(await h.img()).text, BUSY);
  assert.equal(h.orders.length, 0);
  assert.equal(h.downloads, 0);
  assert.equal(h.db.log.length, 0);
  for (const bad of [{ psid: "12", pageId: PAGE, slug: "a" }, { psid: PSID, pageId: "", slug: "a" }, { psid: PSID, pageId: PAGE, slug: "A b" }]) await assert.rejects(loadCourseOrders(bad, ordersDb([])));
});

test("FIX-102 unknown ticket + complete draft + bill: no order; no META_APP_ID: a human echo never sets adminSeenAt, so the busy message still comes", async () => {
  const h = harness();
  h.activeFn = down;
  await h.seed({ course: "khoa-a", gmail: "a@gmail.com", gmailOk: true });
  const out = await h.img();
  assert.equal(last(out).text, BUSY);
  assert.equal(h.orders.length, 0);
  assert.equal(h.downloads, 0);
  assert.equal((await h.state()).course, "khoa-a");
  const n = harness({ env: { META_APP_ID: "" } });
  n.activeFn = down;
  await n.seed({});
  await n.echo(1);
  assert.equal((await n.state()).adminSeenAt, 0);
  assert.equal(last(await n.say("hi")).text, BUSY);
});

test("FIX-103 a stale switchRef is not used for another course or an unrelated ref", async () => {
  const wrong = harness();
  await wrong.seed({ course: "khoa-a", switchRef: { slug: "khoa_b", ref: "c__khoa_b" } });
  await wrong.press("SWITCH:khoa-zzz");
  assert.equal((await wrong.state()).ref, null);
  const bad = harness();
  await bad.seed({ course: "khoa-a", switchRef: { slug: "khoa_b", ref: "c__khoa-a" } });
  await bad.press("SWITCH:khoa_b");
  const s = await bad.state();
  assert.deepEqual([s.course, s.ref], ["khoa_b", null], "ref names another course");
});

test("FIX-104 'Xem chi tiết' after 12 hours with a draft is answered, not turned into the U8 question", async () => {
  const h = harness();
  await h.seed({ course: "khoa-a", lastInboundAt: T0 });
  h.later(H12);
  const out = await h.press("DETAIL:khoa_b");
  assert.ok(last(out).text.startsWith("Khóa B"));
  assert.ok(!JSON.stringify(out).includes("Trước đó"));
});

test("FIX-105 GMAIL_OK confirms only the Gmail it was pressed for: a new Gmail typed during the lookup stays unconfirmed", async () => {
  let injected = false;
  const h = harness();
  await h.seed({});
  await h.press("BUY:khoa-a");
  await h.say("x@gmail.com");
  const inner = h.convo.deps.loadCourseOrders;
  h.convo.deps.loadCourseOrders = async (a) => {
    if (!injected) { injected = true; await h.say("y@gmail.com"); }
    return inner(a);
  };
  const out = await h.press("GMAIL_OK");
  const s = await h.state();
  assert.deepEqual([s.gmail, s.gmailOk], ["y@gmail.com", false], "y not confirmed");
  assert.ok(!out.some((m) => /Chuyển khoản/.test(m.text || "")), "no transfer details for the stale press");
  assert.equal(h.orders.length, 0);
});
