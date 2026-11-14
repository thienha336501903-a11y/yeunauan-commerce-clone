// Messenger support tickets (M-A): redaction, DB helpers, bot with the flag on, Admin endpoint, Admin page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { redactSummary, openTicket, activeTicket, setTicketStatus, touchTicket, markTicketSeen, listTicketRows } from "../utils/messenger/tickets.js";
import { step, emptyState, TICKET_OK_TEXT, TICKET_FAIL_TEXT } from "../utils/messenger/bot.js";
import { MessengerConversation, loadFaq } from "../cloudflare/commerce-worker/src/messenger.js";
import { createHandler } from "../cloudflare/commerce-worker/src/messenger-tickets.js";
import { runCompatHandler } from "../cloudflare/commerce-worker/src/http-compat.js";
import worker from "../cloudflare/commerce-worker/src/index.js";

const textOf = (m) => m.text ?? m.attachment?.payload?.text;
const PSID = "1234567890123";
const PAGE = "555";
const COURSES = [{ slug: "khoa-test", title: "Khoá TEST", price: "100.000đ", bankName: "VCB", bankAccount: "0123", bankOwner: "A", transferNote: "TEST", qrImageUrl: "" }];
const FAQ = [
  { id: "faq-login", question: "Mua rồi vào học ở đâu?", keywords: ["vao hoc"], answer: "Vào trang học.", status: "approved" },
  { id: "faq-video", question: "Video không chạy?", keywords: ["video"], answer: "Mở bằng Chrome.", status: "draft" },
  { id: "faq-refund", question: "Hoàn tiền?", keywords: ["hoan tien"], answer: "", status: "approved" }
];
const optionsOf = (m) => [...(m.attachment?.payload?.buttons || []), ...(m.quick_replies || [])].map((q) => q.payload);
const UUID = "123e4567-e89b-42d3-a456-426614174000";

// In-memory stand-in for the supabase query builder, enough for tickets.js. Mimics the partial unique index (23505).
function fakeDb({ failInsert = false, failAll = false, noActivityColumns = false, missingCode = "42703" } = {}) {
  const rows = [];
  const log = [];
  let seq = 0;
  const builder = (table) => {
    const q = { op: "select", filters: [], order: null, lim: null, single: false };
    const run = () => {
      log.push(q.op);
      if (failAll) return { error: { code: "XX000" } };
      // A database before migration 20261114100000 (Production until its gate): the two columns are unknown.
      if (noActivityColumns && ((q.payload && ("customer_msg_at" in q.payload || "seen_at" in q.payload)) || /customer_msg_at|seen_at/.test(q.cols || ""))) return { error: { code: q.op === "update" ? missingCode : "42703" } };
      const match = (r) => q.filters.every(([k, v, isIn]) => (isIn ? v.includes(r[k]) : r[k] === v));
      if (q.op === "insert") {
        if (failInsert) return { error: { code: "XX000" } };
        if (rows.some((r) => r.page_id === q.payload.page_id && r.psid === q.payload.psid && ["open", "in_progress"].includes(r.status))) return { error: { code: "23505" } };
        const row = { id: `id-${++seq}`, status: "open", created_at: new Date().toISOString(), ...q.payload };
        rows.push(row);
        return { data: q.single ? { id: row.id } : [{ id: row.id }], error: null };
      }
      const hit = rows.filter(match);
      if (q.op === "update") { hit.forEach((r) => Object.assign(r, q.payload)); return { data: hit.map((r) => ({ id: r.id })), error: null }; }
      let out = hit.map((r) => ({ ...r }));
      if (q.lim) out = out.slice(0, q.lim);
      return { data: q.maybe ? out[0] || null : out, error: null };
    };
    const api = {
      insert(p) { q.op = "insert"; q.payload = p; return api; },
      update(p) { q.op = "update"; q.payload = p; return api; },
      select(cols) { q.cols = cols; return api; },
      eq(k, v) { q.filters.push([k, v]); return api; },
      in(k, v) { q.filters.push([k, v, true]); return api; },
      order() { return api; },
      limit(n) { q.lim = n; return api; },
      single() { q.single = true; return api; },
      maybeSingle() { q.maybe = true; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); }
    };
    return api;
  };
  return { rows, log, from: builder };
}

test("redactSummary hides e-mail, phone, account number and caps at 200", () => {
  const out = redactSummary("mail a.b@gmail.com sdt 0912 345 678 stk 0123456789 xong");
  assert.equal(out, "mail [email] sdt [số] stk [số] xong");
  assert.equal(redactSummary("x".repeat(500)).length, 200);
  assert.equal(redactSummary("còn 12345 đồng"), "còn 12345 đồng", "5 digits are not a number to hide");
});

test("openTicket: one row, repeat touches the open one, other errors do not throw", async () => {
  const db = fakeDb();
  const first = await openTicket({ pageId: PAGE, psid: PSID, reason: "human", summary: "gặp admin" }, db);
  assert.equal(first.ok, true);
  for (let i = 0; i < 9; i++) assert.deepEqual(await openTicket({ pageId: PAGE, psid: PSID, reason: "human" }, db), { ok: true, existing: true });
  assert.equal(db.rows.length, 1);
  assert.deepEqual(await openTicket({ pageId: PAGE, psid: PSID, reason: "human" }, fakeDb({ failInsert: true })), { ok: false });
  await assert.rejects(activeTicket({ pageId: PAGE, psid: PSID }, fakeDb({ failAll: true })));
});

test("setTicketStatus: only open->in_progress and open|in_progress->done, uuid required", async () => {
  const db = fakeDb();
  db.rows.push({ id: UUID, page_id: PAGE, psid: PSID, status: "open" });
  assert.equal((await setTicketStatus("nope", "done", db)).status, 400);
  assert.equal((await setTicketStatus(UUID, "open", db)).status, 400);
  assert.equal((await setTicketStatus(UUID, "in_progress", db)).ok, true);
  assert.equal((await setTicketStatus(UUID, "in_progress", db)).status, 400, "no in_progress -> in_progress");
  assert.equal((await setTicketStatus(UUID, "done", db)).ok, true);
  assert.ok(db.rows[0].done_at && db.rows[0].taken_at);
  assert.equal((await setTicketStatus(UUID, "done", db)).status, 400, "done is final");
});

// ---- bot with the flag on ----
const tctx = (extra = {}) => ({ now: 1_000_000, courses: COURSES, ticketsEnabled: true, faq: FAQ, activeTicket: null, ...extra });
const MENU_PAYLOADS = ["BUY", "LIST", "ADMIN"];

// G-LIVE-ux F-A2: the second miss offers an Admin (a button), it never opens a ticket by itself.
test("flag on: GET_STARTED and unclear text show the 4-button menu; second miss offers an Admin, no ticket", () => {
  let out = step(emptyState(), { kind: "postback", payload: "GET_STARTED" }, tctx());
  assert.deepEqual(optionsOf(out.replies.at(-1)), MENU_PAYLOADS);
  out = step(emptyState(), { kind: "text", text: "asdf qwer" }, tctx());
  assert.deepEqual(optionsOf(out.replies.at(-1)), MENU_PAYLOADS);
  assert.equal(out.state.misses, 1);
  assert.equal(out.action, undefined);
  out = step(out.state, { kind: "text", text: "zzz" }, tctx());
  assert.equal(out.action, undefined);
  assert.match(out.replies.at(-1).text, /Bạn có muốn Admin hỗ trợ thêm không\?/);
  out = step({ ...emptyState(), misses: 1 }, { kind: "text", text: "vào học ở đâu" }, tctx());
  assert.equal(out.state.misses, 0, "a match resets the counter");
  assert.match(out.replies.at(-1).text, /Vào trang học/);
});

test("flag on: greetings show the menu and never count as a miss; real misses still open a ticket", () => {
  for (const t of ["hi", "Hi!", "hiii", "hello", "Chào shop", "xin chào ạ", "alo 👋", "shop ơi", "dạ chào bạn ơi", "hello ad ơi"]) {
    const out = step({ ...emptyState(), greeted: true, misses: 1 }, { kind: "text", text: t }, tctx());
    assert.equal(out.action, undefined, t);
    assert.equal(out.state.misses, 0, t);
    assert.deepEqual(optionsOf(out.replies.at(-1)), MENU_PAYLOADS, t);
    assert.doesNotMatch(textOf(out.replies.at(-1)), /chưa hiểu/, t);
  }
  let out = step(emptyState(), { kind: "text", text: "hi" }, tctx());
  assert.match(out.replies[0].text, /trợ lý tự động/, "first greeting still says automated");
  out = step(out.state, { kind: "text", text: "hi" }, tctx());
  assert.equal(out.action, undefined, "two greetings open no ticket");
  // G-LIVE-ux F-A5: "cho hỏi giá" is a price question (course list, no miss).
  for (const t of ["hi bạn ơi cho hỏi giá", "chào", "hiểu"]) {
    // only "chào" alone is a greeting; a question that starts with hi is not swallowed
    const r = step({ ...emptyState(), greeted: true }, { kind: "text", text: t }, tctx());
    assert.equal(r.state.misses, t === "hiểu" ? 1 : 0, t);
  }
  out = step({ ...emptyState(), greeted: true }, { kind: "text", text: "asdf" }, tctx());
  out = step(out.state, { kind: "text", text: "qwer" }, tctx());
  assert.equal(out.action, undefined); // G-LIVE-ux F-A2: an offer, no ticket
  assert.match(out.replies.at(-1).text, /Admin hỗ trợ thêm/);
});

test("'menu' shows the menu and keeps the order; 'Khoá khác' still starts over", () => {
  const withOrder = { ...emptyState(), greeted: true, course: "khoa-test", gmail: "a@gmail.com", gmailOk: true, orderId: UUID };
  for (const c of [tctx(), { ...tctx(), ticketsEnabled: false }]) {
    for (const m of ["menu.", "Menu ạ"]) assert.equal(step(withOrder, { kind: "text", text: m }, c).state.orderId, UUID, m);
    let out = step(withOrder, { kind: "text", text: "Menu" }, c);
    assert.equal(out.state.orderId, UUID);
    assert.equal(out.state.course, null, "legacy state: the draft was spent on the order");
    assert.ok(out.replies.at(-1).quick_replies?.length);
    out = step(out.state, { kind: "text", text: "đơn của tôi sao rồi" }, c);
    // Tickets on (G-LIVE-ux F-A1): a question about the order asks the DO for this sender's pending + approved orders instead of listing all of them.
    assert.deepEqual(out.action, c.ticketsEnabled ? { type: "myOrders" } : { type: "orderStatus", mode: "list", orders: [{ id: UUID, slug: "khoa-test" }] }, "order still found after menu");
    out = step(withOrder, { kind: "postback", payload: "RESTART" }, c);
    assert.equal(out.state.course, null, "RESTART clears the draft");
    assert.deepEqual(out.state.orders, [{ id: UUID, slug: "khoa-test" }], "RESTART keeps the orders");
    out = step(withOrder, { kind: "text", text: "khoá khác" }, c);
    assert.equal(out.state.orders.length, 1);
  }
});

test("flag on: FAQ draft is never sent, approved is; FAQ without answer goes to a ticket", () => {
  let out = step(emptyState(), { kind: "text", text: "video bị lỗi" }, tctx());
  assert.ok(!JSON.stringify(out.replies).includes("Chrome"));
  out = step({ ...emptyState(), greeted: true }, { kind: "postback", payload: "FAQ:faq-video" }, tctx());
  assert.deepEqual(out.action, { type: "openTicket", reason: "unclear" });
  out = step({ ...emptyState(), greeted: true }, { kind: "postback", payload: "FAQ:faq-login" }, tctx());
  assert.equal(out.replies[0].text, "Vào trang học.");
  out = step({ ...emptyState(), greeted: true }, { kind: "postback", payload: "MENU_FAQ" }, tctx());
  assert.deepEqual(out.replies[0].quick_replies.map((q) => q.payload), ["FAQ:faq-login", "FAQ:faq-refund"], "drafts are not listed");
  out = step({ ...emptyState(), greeted: true }, { kind: "text", text: "hoàn tiền" }, tctx());
  // G-LIVE-ux F-A9: "hoàn tiền" is a money incident: a support ticket whose summary is the customer's sentence.
  assert.deepEqual(out.action, { type: "openTicket", reason: "support", summary: "hoàn tiền" }, "refund always goes to a person");
  out = step({ ...emptyState(), greeted: true }, { kind: "postback", payload: "MENU_BOUGHT" }, tctx({ faq: [] }));
  assert.deepEqual(out.action, { type: "openTicket", reason: "self_help" });
});

test("flag on: an open ticket keeps the bot silent; echo rules", () => {
  const silent = step(emptyState(), { kind: "text", text: "hi" }, tctx({ activeTicket: { id: "t1" } }));
  assert.deepEqual(silent.replies, []);
  assert.deepEqual(silent.action, { type: "touchTicket" });
  assert.deepEqual(step(emptyState(), { kind: "echo", fromThisApp: false }, tctx({ appIdKnown: true })).action, { type: "openTicket", reason: "admin_reply", status: "in_progress" });
  assert.equal(step(emptyState(), { kind: "echo", fromThisApp: false }, tctx()).action, undefined, "no META_APP_ID: echoes are ignored");
  const own = step(emptyState(), { kind: "echo", fromThisApp: true }, tctx({ appIdKnown: true }));
  assert.equal(own.action, undefined);
  assert.equal(own.state.pausedUntil, 0, "no 12 hour pause with the flag on");
});

// ---- Durable Object with the flag on ----
function fakeStorage() {
  const map = new Map();
  return { async get(k) { return map.has(k) ? structuredClone(map.get(k)) : undefined; }, async put(k, v) { map.set(k, structuredClone(v)); } };
}
const msg = (mid, message) => ({ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, message: { mid, ...message } });
const echo = (mid, appId) => ({ sender: { id: PAGE }, recipient: { id: PSID }, timestamp: 1, message: { mid, is_echo: true, app_id: appId, text: "xin chào" } });

function ticketConvo({ db = fakeDb(), env = {}, deps = {} } = {}) {
  const sent = [];
  let clock = 1_000_000; // G-LIVE-ux: a moving clock (the handoff reset compares read time with confirm time)
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body).message); return new Response("{}", { status: 200 }); };
  const convo = new MessengerConversation({ storage: fakeStorage() }, { META_PAGE_ACCESS_TOKEN: "t", META_APP_ID: "777", META_PAGE_ID: PAGE, MESSENGER_TICKETS_ENABLED: "1", ...env }, {
    fetchImpl, now: () => (clock += 1), loadCourses: async () => COURSES, loadFaq: () => FAQ.filter((f) => f.status === "approved"),
    activeTicket: (a) => activeTicket(a, db), openTicket: (a) => openTicket(a, db), touchTicket: async () => {}, loadCourseOrders: async () => [], ...deps
  });
  return { convo, db, sent };
}

test("DO: 'gặp admin' writes one ticket and says so; 10 spams still one ticket and the bot goes quiet", async () => {
  const { convo, db, sent } = ticketConvo();
  await convo.handle(PSID, msg("m0", { text: "cho mình gặp admin, sdt 0912345678" }));
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].summary, "cho mình gặp admin, sdt [số]");
  assert.equal(sent.at(-1).text, TICKET_OK_TEXT);
  const before = sent.length;
  for (let i = 1; i <= 10; i++) await convo.handle(PSID, msg(`m${i}`, { text: "gặp admin" }));
  assert.equal(db.rows.length, 1);
  assert.equal(sent.length, before, "silent while the ticket is open");
  db.rows[0].status = "done";
  await convo.handle(PSID, msg("m20", { text: "hi" }));
  assert.ok(sent.length > before, "bot answers again once the ticket is done");
  assert.ok(optionsOf(sent.at(-1)).includes("ADMIN"));
});

test("DO: a first message that opens a ticket still starts with the automated-assistant greeting", async () => {
  const { convo, sent } = ticketConvo();
  await convo.handle(PSID, msg("g1", { text: "gặp admin" }));
  assert.match(sent[0].text, /trợ lý tự động/);
  assert.equal(sent.at(-1).text, TICKET_OK_TEXT);
});

test("DO: without META_APP_ID echoes open no ticket; Admin echo on an open ticket marks it in progress", async () => {
  const bare = ticketConvo({ env: { META_APP_ID: "" } });
  await bare.convo.handle(PSID, echo("e1", 999));
  assert.equal(bare.db.rows.length, 0);
  const { convo, db } = ticketConvo();
  await convo.handle(PSID, msg("m1", { text: "gặp admin" }));
  assert.equal(db.rows[0].status, "open");
  await convo.handle(PSID, echo("e2", 999));
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].status, "in_progress");
  assert.ok(db.rows[0].taken_at);
});

test("flag on: a very short course title does not match free text", () => {
  const out = step({ ...emptyState(), greeted: true }, { kind: "text", text: "abc xyz" }, tctx({ courses: [{ slug: "k1", title: "A" }] }));
  assert.equal(out.state.course, null);
});

test("DO: race (no ticket seen, insert hits the unique index) still gives one row", async () => {
  const db = fakeDb();
  const { convo, sent } = ticketConvo({ db, deps: { activeTicket: async () => null } });
  for (let i = 0; i < 3; i++) await convo.handle(PSID, msg(`r${i}`, { text: "gặp admin" }));
  assert.equal(db.rows.length, 1);
  assert.equal(sent.filter((m) => m.text === TICKET_OK_TEXT).length, 3);
});

test("DO: insert failure gives the honest error text, never 'đã chuyển'", async () => {
  const { convo, sent } = ticketConvo({ db: fakeDb({ failInsert: true }) });
  await convo.handle(PSID, msg("m1", { text: "gặp admin" }));
  assert.equal(sent.at(-1).text, TICKET_FAIL_TEXT);
  assert.ok(!sent.some((m) => /đã chuyển/.test(m.text || "")));
});

test("DO: DB error while reading the ticket = carry on as if none", async () => {
  const { convo, sent } = ticketConvo({ deps: { activeTicket: async () => { throw new Error("db down"); } } });
  await convo.handle(PSID, msg("m1", { text: "hi" }));
  assert.ok(sent.length > 0);
});

test("DO: Admin echo opens an in-progress admin_reply ticket without replying; the app's own echo does not", async () => {
  const { convo, db, sent } = ticketConvo();
  await convo.handle(PSID, echo("e1", 777));
  assert.equal(db.rows.length, 0);
  await convo.handle(PSID, echo("e2", 999));
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].reason, "admin_reply");
  assert.equal(db.rows[0].status, "in_progress");
  assert.equal(db.rows[0].summary, "");
  assert.equal(sent.length, 0);
  await convo.handle(PSID, msg("m1", { text: "hi" }));
  assert.equal(sent.length, 0, "bot silent while Admin handles it");
});

// G-LIVE-ux F-A2: two misses offer an Admin and open no ticket.
test("DO: unclear twice offers an Admin and opens no ticket", async () => {
  const { convo, db, sent } = ticketConvo();
  await convo.handle(PSID, msg("m1", { text: "asdf" }));
  assert.equal(db.rows.length, 0);
  await convo.handle(PSID, msg("m2", { text: "qwer" }));
  assert.equal(db.rows.length, 0);
  assert.match(sent.at(-1).text, /Admin hỗ trợ thêm/);
});

test("DO: sales flow still works with the flag on (course -> Gmail -> confirm -> bill -> order)", async () => {
  const calls = [];
  const IMG = "https://scontent.xx.fbcdn.net/v/bill.jpg";
  const { convo, sent } = ticketConvo({ deps: { createBillOrder: async (input) => { calls.push(input); return { status: 200, body: { orderId: "o1" } }; } } });
  const fetchWithImage = convo.deps.fetchImpl;
  convo.deps.fetchImpl = async (url, init) => {
    if (String(url).startsWith("https://scontent.")) {
      const res = new Response(new Uint8Array([0xff, 0xd8, 0xff, 1]), { status: 200, headers: { "content-type": "image/jpeg" } });
      Object.defineProperty(res, "url", { value: String(url) });
      return res;
    }
    return fetchWithImage(url, init);
  };
  await convo.handle(PSID, msg("m1", { text: "Khoá TEST", quick_reply: { payload: "COURSE:khoa-test" } }));
  await convo.handle(PSID, msg("m2", { text: "mail hoc.vien@gmail.com" }));
  await convo.handle(PSID, msg("m3", { text: "Đúng", quick_reply: { payload: "GMAIL_OK" } }));
  await convo.handle(PSID, msg("m4", { attachments: [{ type: "image", payload: { url: IMG } }] }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].gmail, "hoc.vien@gmail.com");
  assert.match(sent.at(-1).text, /đã nhận bill/);
});

test("DO: flag off keeps H4 behaviour (no ticket lookup, 12 hour pause)", async () => {
  let looked = 0;
  const { convo, db, sent } = ticketConvo({ env: { MESSENGER_TICKETS_ENABLED: "0" }, deps: { activeTicket: async () => { looked++; return null; } } });
  await convo.handle(PSID, msg("m1", { text: "gặp admin" }));
  assert.equal(looked, 0);
  assert.equal(db.rows.length, 0);
  assert.match(sent.at(-1).text, /Mình đã chuyển yêu cầu của bạn tới Admin/);
});

test("loadFaq returns nothing while every faq.json entry is a draft", () => {
  assert.deepEqual(loadFaq(), []);
  const all = JSON.parse(readFileSync(new URL("../utils/messenger/faq.json", import.meta.url), "utf8"));
  assert.ok(all.length >= 10 && all.every((f) => f.status === "draft"));
});

// ---- Admin endpoint ----
async function call(handler, { method = "GET", password, body, flag = "1", adminPassword = "pw", path = "/api/messenger-tickets" } = {}) {
  process.env.MESSENGER_TICKETS_ENABLED = flag;
  process.env.ADMIN_PASSWORD = adminPassword;
  const headers = { "content-type": "application/json", ...(password === undefined ? {} : { "x-admin-password": password }) };
  const res = await runCompatHandler(handler, new Request("https://yeubep.shop" + path, { method, headers, body: body && JSON.stringify(body) }));
  return { status: res.status, json: await res.json().catch(() => null) };
}

test("endpoint: auth, flag, list without full psid, status validation", async () => {
  const db = fakeDb();
  db.rows.push({ id: UUID, page_id: PAGE, psid: PSID, reason: "human", summary: "s", status: "open", created_at: "2026-11-07T00:00:00Z" });
  const handler = createHandler(db);
  try {
    assert.equal((await call(handler)).status, 401);
    assert.equal((await call(handler, { password: "wrong" })).status, 401);
    assert.equal((await call(handler, { password: "x", adminPassword: "" })).status, 401);
    assert.equal((await call(handler, { password: "pw", flag: "0" })).status, 404);
    const ok = await call(handler, { password: "pw" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.tickets[0].psidTail, PSID.slice(-4));
    assert.ok(!JSON.stringify(ok.json).includes(PSID));
    assert.equal((await call(handler, { method: "POST", password: "pw", body: { id: "not-a-uuid", status: "done" } })).status, 400);
    assert.equal((await call(handler, { method: "POST", password: "pw", body: { id: UUID, status: "bogus" } })).status, 400);
    assert.equal((await call(handler, { method: "POST", password: "pw", body: { id: UUID, status: "done" } })).status, 200);
    const broken = await call(createHandler(fakeDb({ failAll: true })), { password: "pw" });
    assert.equal(broken.status, 500);
    assert.ok(!JSON.stringify(broken.json).includes("XX000"));
  } finally {
    delete process.env.MESSENGER_TICKETS_ENABLED;
    delete process.env.ADMIN_PASSWORD;
  }
});

test("endpoint: active tickets carry the customer's Facebook name (server-side lookup), never the full PSID; failures leave no name", async () => {
  const db = fakeDb();
  const DONE = "22222222-2222-4222-8222-222222222222";
  db.rows.push({ id: UUID, page_id: PAGE, psid: PSID, reason: "support", summary: "s", status: "in_progress", created_at: "2026-11-14T00:00:00Z", updated_at: "2026-11-14T00:05:00Z" });
  db.rows.push({ id: DONE, page_id: PAGE, psid: "998877665544", reason: "human", summary: "x", status: "done", created_at: "2026-11-13T00:00:00Z", done_at: "2026-11-13T01:00:00Z" });
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.Authorization });
    // Shape Meta returned in Graph API Explorer (14/11): the Page is the other participant.
    return new Response(JSON.stringify({ data: [{ participants: { data: [{ name: "Phạm Hùng", id: PSID }, { name: "Yêu học bánh", id: PAGE }] }, id: "t_1" }] }), { status: 200 });
  };
  try {
    process.env.META_PAGE_ACCESS_TOKEN = "tok";
    const ok = await call(createHandler(db, { fetchImpl }), { password: "pw" });
    assert.equal(ok.status, 200);
    const active = ok.json.tickets.find((t) => t.id === UUID);
    const done = ok.json.tickets.find((t) => t.id === DONE);
    assert.equal(active.name, "Phạm Hùng");
    assert.equal(active.updated_at, "2026-11-14T00:05:00Z");
    assert.equal(done.name, undefined); // no lookup for closed tickets
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/v\d+\.\d+\/me\/conversations\?platform=messenger&user_id=\d+&fields=participants$/);
    assert.equal(seen[0].auth, "Bearer tok"); // token in the header, never the URL
    assert.ok(!JSON.stringify(ok.json).includes(PSID));
    for (const bad of [async () => new Response("{}", { status: 400 }), async () => { throw new Error("net"); }, async () => new Response("{}", { status: 200 })]) {
      const r = await call(createHandler(db, { fetchImpl: bad }), { password: "pw" });
      assert.equal(r.status, 200);
      assert.equal(r.json.tickets.find((t) => t.id === UUID).name, undefined);
    }
    delete process.env.META_PAGE_ACCESS_TOKEN;
    let called = 0;
    const noTok = await call(createHandler(db, { fetchImpl: async () => { called++; return new Response("{}"); } }), { password: "pw" });
    assert.equal(noTok.status, 200);
    assert.equal(called, 0); // no token: no Meta call
  } finally {
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.MESSENGER_TICKETS_ENABLED;
    delete process.env.ADMIN_PASSWORD;
  }
});

test("fetchProfileName: odd PSID or no token makes no call; only the participant with this PSID counts, never the Page; trimmed and capped", async () => {
  const { fetchProfileName } = await import("../utils/messenger/meta.js");
  let n = 0;
  const conv = (people) => async () => { n++; return new Response(JSON.stringify({ data: [{ participants: { data: people } }] }), { status: 200 }); };
  const f = conv([{ name: "Yêu học bánh", id: PAGE }, { name: "  Lan  " + "x".repeat(100), id: PSID }]);
  assert.equal(await fetchProfileName("abc", { token: "t", fetchImpl: f }), "");
  assert.equal(await fetchProfileName("1/../me", { token: "t", fetchImpl: f }), "");
  assert.equal(await fetchProfileName(PSID, { token: "", fetchImpl: f }), "");
  assert.equal(n, 0);
  const name = await fetchProfileName(PSID, { token: "t", fetchImpl: f });
  assert.ok(name.startsWith("Lan x") && name.length === 80);
  assert.equal(await fetchProfileName(PSID, { token: "t", fetchImpl: conv([{ name: "Yêu học bánh", id: PAGE }]) }), ""); // Page only: no name
  assert.equal(await fetchProfileName(PSID, { token: "t", fetchImpl: conv([{ name: "Người khác", id: "998877665544" }]) }), ""); // someone else's id
});

test("endpoint: at most 20 name lookups, newest tickets first; a hung Graph call times out to no name", async () => {
  const db = fakeDb();
  for (let i = 0; i < 21; i++) {
    db.rows.push({ id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, page_id: PAGE, psid: String(1000000 + i), reason: "human", summary: "", status: "open", created_at: new Date(Date.UTC(2026, 10, 14, 0, i)).toISOString() });
  }
  const seen = [];
  try {
    process.env.META_PAGE_ACCESS_TOKEN = "tok";
    const r = await call(createHandler(db, { fetchImpl: async (url) => { seen.push(String(url)); return new Response(JSON.stringify({ data: [] }), { status: 200 }); } }), { password: "pw" });
    assert.equal(r.status, 200);
    assert.equal(seen.length, 20);
    assert.ok(!seen.some((u) => u.includes("user_id=1000000&"))); // the oldest one is the one left out
  } finally {
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.MESSENGER_TICKETS_ENABLED;
    delete process.env.ADMIN_PASSWORD;
  }
  const { fetchProfileName } = await import("../utils/messenger/meta.js");
  const hung = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  assert.equal(await fetchProfileName(PSID, { token: "t", fetchImpl: hung, timeoutMs: 20 }), "");
});

test("Admin page: 'Nhận xử lý' and 'Mở chat' open the inbox inside the click and copy the name; no data in the URL", () => {
  const html = readFileSync(new URL("../orders.html", import.meta.url), "utf8");
  assert.match(html, /const INBOX_URL = "https:\/\/business\.facebook\.com\/latest\/inbox\/all";/);
  assert.match(html, /window\.open\(INBOX_URL, "_blank", "noopener"\)/);
  assert.match(html, /take\.addEventListener\("click", \(\) => \{ openInbox\(t\); updateTicket\(t\.id, "in_progress"\); \}\)/);
  assert.match(html, /chat\.addEventListener\("click", \(\) => openInbox\(t\)\)/);
  assert.match(html, /navigator\.clipboard\.writeText\(t\.name\)/);
});

test("worker routes /api/messenger-tickets and answers 404 while the flag is off", async () => {
  const res = await worker.fetch(new Request("https://yeubep.shop/api/messenger-tickets"), { ASSETS: { fetch: async () => new Response("") } });
  assert.equal(res.status, 404);
  assert.ok(res.headers.get("x-frame-options") || res.headers.get("content-security-policy"));
});

test("Admin page: ticket block renders with createElement/textContent only", () => {
  const html = readFileSync(new URL("../orders.html", import.meta.url), "utf8");
  const start = html.indexOf("// Messenger support tickets.");
  const end = html.indexOf("async function loadOrders()");
  assert.ok(start > 0 && end > start);
  const block = html.slice(start, end);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(block));
  assert.ok(!/`[^`]*\$\{/.test(block), "no template strings with data");
  assert.match(block, /textContent/);
  assert.match(html, /<section id="ticketBox"[^>]*hidden/);
  assert.match(html, /href="https:\/\/business\.facebook\.com\/latest\/inbox\/all" target="_blank" rel="noopener"/);
});

test("migration grants the service role exactly what tickets.js uses, nothing to anon/authenticated", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261107100000_messenger_support_tickets.sql", import.meta.url), "utf8");
  assert.match(sql, /grant select, insert, update on table public\.messenger_support_tickets to service_role;/);
  assert.match(sql, /revoke all on table public\.messenger_support_tickets from public, anon, authenticated;/);
  assert.match(sql, /force row level security;/);
  assert.doesNotMatch(sql, /grant[^;]*to[^;]*\b(anon|authenticated)\b/i);
});

// ---- "Có tin mới" (Owner 14/11): customer_msg_at / seen_at ----
test("ACT-1 touchTicket marks a customer message on an open ticket only; a ticket closed meanwhile is not flagged", async () => {
  const db = fakeDb();
  db.rows.push({ id: UUID, page_id: PAGE, psid: PSID, reason: "support", summary: "", status: "in_progress", created_at: "2026-11-14T00:00:00Z" });
  await touchTicket(UUID, db);
  assert.ok(db.rows[0].customer_msg_at && db.rows[0].updated_at);
  db.rows[0].status = "done";
  delete db.rows[0].customer_msg_at;
  await touchTicket(UUID, db);
  assert.equal(db.rows[0].customer_msg_at, undefined);
});

test("ACT-2 an Admin reply from the inbox on an open ticket counts as seen; a new ticket from an Admin reply has no customer message", async () => {
  const db = fakeDb();
  db.rows.push({ id: UUID, page_id: PAGE, psid: PSID, reason: "support", summary: "", status: "open", created_at: "2026-11-14T00:00:00Z", customer_msg_at: "2026-11-14T00:01:00.000Z" });
  const r = await openTicket({ pageId: PAGE, psid: PSID, reason: "admin_reply", status: "in_progress" }, db);
  assert.equal(r.existing, true);
  assert.ok(db.rows[0].seen_at > db.rows[0].customer_msg_at);
  assert.equal(db.rows[0].status, "in_progress");
  const db2 = fakeDb();
  db2.rows.push({ id: UUID, page_id: PAGE, psid: PSID, reason: "support", summary: "", status: "open", created_at: "2026-11-14T00:00:00Z" });
  await openTicket({ pageId: PAGE, psid: PSID, reason: "human" }, db2); // a customer request on an open ticket is not "seen"
  assert.equal(db2.rows[0].seen_at, undefined);
});

test("ACT-3 markTicketSeen: open tickets only, uuid required; a database without the columns answers not_migrated", async () => {
  const db = fakeDb();
  db.rows.push({ id: UUID, page_id: PAGE, psid: PSID, reason: "support", summary: "", status: "open", created_at: "2026-11-14T00:00:00Z" });
  assert.equal((await markTicketSeen("nope", db)).status, 400);
  assert.equal((await markTicketSeen(UUID, db)).ok, true);
  assert.ok(db.rows[0].seen_at);
  db.rows[0].status = "done";
  assert.equal((await markTicketSeen(UUID, db)).status, 400);
  const old = fakeDb({ noActivityColumns: true });
  old.rows.push({ id: UUID, page_id: PAGE, psid: PSID, reason: "support", summary: "", status: "open", created_at: "2026-11-14T00:00:00Z" });
  assert.deepEqual(await markTicketSeen(UUID, old), { ok: false, status: 409, error: "not_migrated" });
});

test("ACT-4 before the migration: list, touch and Admin-reply still work on the old columns (no 500, no lost ticket)", async () => {
  const db = fakeDb({ noActivityColumns: true });
  db.rows.push({ id: UUID, page_id: PAGE, psid: PSID, reason: "support", summary: "", status: "open", created_at: "2026-11-14T00:00:00Z" });
  assert.equal((await listTicketRows(db)).length, 1);
  await touchTicket(UUID, db);
  assert.ok(db.rows[0].updated_at);
  assert.equal((await openTicket({ pageId: PAGE, psid: PSID, reason: "admin_reply", status: "in_progress" }, db)).ok, true);
  assert.equal(db.rows[0].status, "in_progress");
  try {
    const r = await call(createHandler(db), { password: "pw" });
    assert.equal(r.status, 200);
    assert.equal(r.json.tickets.length, 1);
  } finally { delete process.env.MESSENGER_TICKETS_ENABLED; delete process.env.ADMIN_PASSWORD; }
});

test("ACT-5 endpoint: ?changes=1 returns ids, status and times of open tickets only (no text, no name, no PSID, no Meta call); 'seen' needs the Admin password", async () => {
  const db = fakeDb();
  db.rows.push({ id: UUID, page_id: PAGE, psid: PSID, reason: "support", summary: "em ck roi", status: "in_progress", created_at: "2026-11-14T00:00:00Z", updated_at: "2026-11-14T00:02:00Z", customer_msg_at: "2026-11-14T00:02:00Z" });
  db.rows.push({ id: "22222222-2222-4222-8222-222222222222", page_id: PAGE, psid: "998877665544", reason: "human", summary: "x", status: "done", created_at: "2026-11-13T00:00:00Z" });
  let metaCalls = 0;
  const handler = createHandler(db, { fetchImpl: async () => { metaCalls++; return new Response("{}"); } });
  try {
    process.env.META_PAGE_ACCESS_TOKEN = "tok";
    const ch = await call(handler, { password: "pw", path: "/api/messenger-tickets?changes=1" });
    assert.equal(ch.status, 200);
    assert.deepEqual(ch.json, { changes: [{ id: UUID, status: "in_progress", updated_at: "2026-11-14T00:02:00Z", customer_msg_at: "2026-11-14T00:02:00Z", seen_at: null }] });
    assert.equal(metaCalls, 0);
    assert.equal((await call(handler, { path: "/api/messenger-tickets?changes=1" })).status, 401);
    assert.equal((await call(handler, { method: "POST", body: { id: UUID, action: "seen" } })).status, 401);
    assert.equal((await call(handler, { method: "POST", password: "pw", body: { id: UUID, action: "seen" } })).status, 200);
    assert.ok(db.rows[0].seen_at);
    assert.equal(db.rows[0].status, "in_progress"); // "Đã xem" does not change the ticket status
  } finally {
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.MESSENGER_TICKETS_ENABLED;
    delete process.env.ADMIN_PASSWORD;
  }
});

test("ACT-6 DO: while a ticket is open a customer message only touches it (bot silent); an Admin echo never touches it; a redelivered mid touches once", async () => {
  const touched = [];
  const { convo, sent } = ticketConvo({ deps: { activeTicket: async () => ({ id: UUID, status: "in_progress" }), touchTicket: async (id) => { touched.push(id); } } });
  const before = sent.length;
  await convo.handle(PSID, msg("c1", { text: "em chuyển khoản rồi" }));
  await convo.handle(PSID, msg("c1", { text: "em chuyển khoản rồi" })); // Meta redelivery
  await convo.handle(PSID, msg("c2", { attachments: [{ type: "image", payload: { url: "https://scontent.xx.fbcdn.net/v/bill.jpg" } }] }));
  await convo.handle(PSID, { sender: { id: PAGE }, recipient: { id: PSID }, timestamp: 1, message: { mid: "e1", is_echo: true, text: "Admin trả lời", app_id: 999 } });
  assert.deepEqual(touched, [UUID, UUID]);
  assert.equal(sent.length, before); // bot silent
});

test("ACT-7 Admin page: 'Có tin mới' badge, newest-first order, 'Đã xem' button, 30-second light check only while visible", () => {
  const html = readFileSync(new URL("../orders.html", import.meta.url), "utf8");
  assert.match(html, /id="ticketNewBadge"/);
  assert.match(html, /function hasNewMessage\(t\)/);
  assert.match(html, /"Có tin mới"/);
  assert.match(html, /"Đã xem"/);
  assert.match(html, /\/api\/messenger-tickets\?changes=1/);
  assert.match(html, /setInterval\(checkTicketChanges, 30000\)/);
  assert.match(html, /if \(document\.hidden \|\| !currentAdminPassword/);
});

test("ACT-8 'Đã xem' records the message time the Admin saw: a message that arrived after the page loaded stays new; a future or bad time falls back to now", async () => {
  const db = fakeDb();
  db.rows.push({ id: UUID, page_id: PAGE, psid: PSID, reason: "support", summary: "", status: "open", created_at: "2026-11-14T00:00:00Z", customer_msg_at: "2026-11-14T00:05:00.000Z" });
  assert.equal((await markTicketSeen(UUID, db, "2026-11-14T00:03:00.000Z")).ok, true);
  assert.equal(db.rows[0].seen_at, "2026-11-14T00:03:00.000Z");
  assert.ok(db.rows[0].customer_msg_at > db.rows[0].seen_at); // still "Có tin mới"
  await markTicketSeen(UUID, db, "2999-01-01T00:00:00Z");
  assert.ok(Date.parse(db.rows[0].seen_at) <= Date.now());
  await markTicketSeen(UUID, db, "not a date");
  assert.ok(Number.isFinite(Date.parse(db.rows[0].seen_at)));
});

test("ACT-9 before the migration with PostgREST's PGRST204 on updates, and ?changes=1 on an unmigrated database: no 500", async () => {
  const db = fakeDb({ noActivityColumns: true, missingCode: "PGRST204" });
  db.rows.push({ id: UUID, page_id: PAGE, psid: PSID, reason: "support", summary: "", status: "open", created_at: "2026-11-14T00:00:00Z" });
  await touchTicket(UUID, db);
  assert.ok(db.rows[0].updated_at);
  assert.equal((await openTicket({ pageId: PAGE, psid: PSID, reason: "admin_reply", status: "in_progress" }, db)).ok, true);
  assert.deepEqual(await markTicketSeen(UUID, db), { ok: false, status: 409, error: "not_migrated" });
  try {
    const r = await call(createHandler(db), { password: "pw", path: "/api/messenger-tickets?changes=1" });
    assert.equal(r.status, 200);
    assert.equal(r.json.changes.length, 1);
    assert.equal(r.json.changes[0].customer_msg_at, null);
  } finally { delete process.env.MESSENGER_TICKETS_ENABLED; delete process.env.ADMIN_PASSWORD; }
});
