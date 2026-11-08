// Messenger support tickets (M-A): redaction, DB helpers, bot with the flag on, Admin endpoint, Admin page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { redactSummary, openTicket, activeTicket, setTicketStatus } from "../utils/messenger/tickets.js";
import { step, emptyState, TICKET_OK_TEXT, TICKET_FAIL_TEXT } from "../utils/messenger/bot.js";
import { MessengerConversation, loadFaq } from "../cloudflare/commerce-worker/src/messenger.js";
import { createHandler } from "../cloudflare/commerce-worker/src/messenger-tickets.js";
import { runCompatHandler } from "../cloudflare/commerce-worker/src/http-compat.js";
import worker from "../cloudflare/commerce-worker/src/index.js";

const PSID = "1234567890123";
const PAGE = "555";
const COURSES = [{ slug: "khoa-test", title: "Khoá TEST", price: "100.000đ", bankName: "VCB", bankAccount: "0123", bankOwner: "A", transferNote: "TEST", qrImageUrl: "" }];
const FAQ = [
  { id: "faq-login", question: "Mua rồi vào học ở đâu?", keywords: ["vao hoc"], answer: "Vào trang học.", status: "approved" },
  { id: "faq-video", question: "Video không chạy?", keywords: ["video"], answer: "Mở bằng Chrome.", status: "draft" },
  { id: "faq-refund", question: "Hoàn tiền?", keywords: ["hoan tien"], answer: "", status: "approved" }
];
const UUID = "123e4567-e89b-42d3-a456-426614174000";

// In-memory stand-in for the supabase query builder, enough for tickets.js. Mimics the partial unique index (23505).
function fakeDb({ failInsert = false, failAll = false } = {}) {
  const rows = [];
  const log = [];
  let seq = 0;
  const builder = (table) => {
    const q = { op: "select", filters: [], order: null, lim: null, single: false };
    const run = () => {
      log.push(q.op);
      if (failAll) return { error: { code: "XX000" } };
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
      select() { return api; },
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

test("flag on: GET_STARTED and unclear text show the 4-button menu; second miss opens an 'unclear' ticket", () => {
  let out = step(emptyState(), { kind: "postback", payload: "GET_STARTED" }, tctx());
  assert.deepEqual(out.replies.at(-1).quick_replies.map((q) => q.payload), MENU_PAYLOADS);
  out = step(emptyState(), { kind: "text", text: "asdf qwer" }, tctx());
  assert.deepEqual(out.replies.at(-1).quick_replies.map((q) => q.payload), MENU_PAYLOADS);
  assert.equal(out.state.misses, 1);
  assert.equal(out.action, undefined);
  out = step(out.state, { kind: "text", text: "zzz" }, tctx());
  assert.deepEqual(out.action, { type: "openTicket", reason: "unclear" });
  out = step({ ...emptyState(), misses: 1 }, { kind: "text", text: "vào học ở đâu" }, tctx());
  assert.equal(out.state.misses, 0, "a match resets the counter");
  assert.match(out.replies.at(-1).text, /Vào trang học/);
});

test("flag on: greetings show the menu and never count as a miss; real misses still open a ticket", () => {
  for (const t of ["hi", "Hi!", "hiii", "hello", "Chào shop", "xin chào ạ", "alo 👋", "shop ơi", "dạ chào bạn ơi", "hello ad ơi"]) {
    const out = step({ ...emptyState(), greeted: true, misses: 1 }, { kind: "text", text: t }, tctx());
    assert.equal(out.action, undefined, t);
    assert.equal(out.state.misses, 0, t);
    assert.deepEqual(out.replies.at(-1).quick_replies.map((q) => q.payload), MENU_PAYLOADS, t);
    assert.doesNotMatch(out.replies.at(-1).text, /chưa hiểu/, t);
  }
  let out = step(emptyState(), { kind: "text", text: "hi" }, tctx());
  assert.match(out.replies[0].text, /trợ lý tự động/, "first greeting still says automated");
  out = step(out.state, { kind: "text", text: "hi" }, tctx());
  assert.equal(out.action, undefined, "two greetings open no ticket");
  for (const t of ["hi bạn ơi cho hỏi giá", "chào", "hiểu"]) {
    // only "chào" alone is a greeting; a question that starts with hi is not swallowed
    const r = step({ ...emptyState(), greeted: true }, { kind: "text", text: t }, tctx());
    assert.equal(r.state.misses, t === "chào" ? 0 : 1, t);
  }
  out = step({ ...emptyState(), greeted: true }, { kind: "text", text: "asdf" }, tctx());
  out = step(out.state, { kind: "text", text: "qwer" }, tctx());
  assert.deepEqual(out.action, { type: "openTicket", reason: "unclear" });
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
    assert.deepEqual(out.action, { type: "orderStatus", mode: "list", orders: [{ id: UUID, slug: "khoa-test" }] }, "order still found after menu");
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
  assert.deepEqual(out.action, { type: "openTicket", reason: "unclear" }, "refund always goes to a person");
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
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body).message); return new Response("{}", { status: 200 }); };
  const convo = new MessengerConversation({ storage: fakeStorage() }, { META_PAGE_ACCESS_TOKEN: "t", META_APP_ID: "777", META_PAGE_ID: PAGE, MESSENGER_TICKETS_ENABLED: "1", ...env }, {
    fetchImpl, now: () => 1_000_000, loadCourses: async () => COURSES, loadFaq: () => FAQ.filter((f) => f.status === "approved"),
    activeTicket: (a) => activeTicket(a, db), openTicket: (a) => openTicket(a, db), touchTicket: async () => {}, ...deps
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
  assert.ok(sent.at(-1).quick_replies.some((q) => q.payload === "ADMIN"));
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

test("DO: unclear twice opens one 'unclear' ticket", async () => {
  const { convo, db, sent } = ticketConvo();
  await convo.handle(PSID, msg("m1", { text: "asdf" }));
  assert.equal(db.rows.length, 0);
  await convo.handle(PSID, msg("m2", { text: "qwer" }));
  assert.equal(db.rows[0].reason, "unclear");
  assert.equal(sent.at(-1).text, TICKET_OK_TEXT);
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
async function call(handler, { method = "GET", password, body, flag = "1", adminPassword = "pw" } = {}) {
  process.env.MESSENGER_TICKETS_ENABLED = flag;
  process.env.ADMIN_PASSWORD = adminPassword;
  const headers = { "content-type": "application/json", ...(password === undefined ? {} : { "x-admin-password": password }) };
  const res = await runCompatHandler(handler, new Request("https://yeubep.shop/api/messenger-tickets", { method, headers, body: body && JSON.stringify(body) }));
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
