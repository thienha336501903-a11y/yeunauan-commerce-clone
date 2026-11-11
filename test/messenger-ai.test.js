// G-MC1: AI for free Messenger text. The model only answers; buttons, orders and tickets stay in code.
import test from "node:test";
import assert from "node:assert/strict";
import { step, stepRaw, emptyState, aiReply, freeTextFallback, ordersOf } from "../utils/messenger/bot.js";
import { badAnswer, aiMessages, parseAiResult, redact, AI_DAILY_CAP, AI_ROUTES } from "../utils/messenger/ai.js";
import { MessengerConversation } from "../cloudflare/commerce-worker/src/messenger.js";

const PSID = "1234567890123";
const COURSES = [{ slug: "khoa-test", title: "Khoá TEST", price: "100.000đ", subtitle: "Phụ đề", description: "<p>Mô tả</p>", featured: true, bankAccount: "9704-SECRET-ACC", bankName: "VCB", bankOwner: "A", transferNote: "N" }];
const FAQ = [
  { id: "faq-login", question: "Vào học ở đâu?", keywords: ["vao hoc"], answer: "FAQ: vào trang học.", status: "approved" },
  { id: "faq-video", question: "Video?", keywords: ["video"], answer: "FAQ: mở bằng Chrome.", status: "draft" },
];
const ctx = (extra = {}) => ({ now: Date.UTC(2026, 10, 10, 5), courses: COURSES, ticketsEnabled: true, faq: FAQ.filter((f) => f.status === "approved"), activeTicket: null, aiEnabled: true, ...extra });
const TXT = (t) => ({ kind: "text", text: t });
const UNCLEAR = "cho em hoi chung chi nghe";
const greeted = () => ({ ...emptyState(), greeted: true });

test("AI-1 flag off / no AI binding / ticketUnknown: no AI action, same as freeTextFallback", () => {
  for (const c of [ctx({ aiEnabled: false }), ctx({ aiEnabled: undefined, ticketUnknown: false })]) {
    const out = stepRaw(greeted(), TXT(UNCLEAR), c);
    assert.notEqual(out.action?.type, "ai");
    assert.deepEqual(out, { ...freeTextFallback({ ...greeted(), lastInboundAt: c.now }), state: out.state });
  }
});

function convo({ env = {}, deps = {}, tickets = [] } = {}) {
  const store = new Map();
  const sent = [];
  const c = new MessengerConversation({ storage: { async get(k) { return store.has(k) ? structuredClone(store.get(k)) : undefined; }, async put(k, v) { store.set(k, structuredClone(v)); } } },
    { META_PAGE_ACCESS_TOKEN: "t", META_APP_ID: "777", META_PAGE_ID: "555", MESSENGER_TICKETS_ENABLED: "1", MESSENGER_AI_ENABLED: "1", AI: { run: async () => ({}) }, ...env },
    {
      fetchImpl: async (u, init) => { sent.push(JSON.parse(init.body).message); return new Response("{}", { status: 200 }); },
      now: () => Date.UTC(2026, 10, 10, 5), loadCourses: async () => COURSES, loadFaq: () => FAQ.filter((f) => f.status === "approved"),
      activeTicket: async () => null, openTicket: async (a) => { tickets.push(a); return { ok: true }; }, touchTicket: async () => {}, loadCourseOrders: async () => [], loadPendingOrders: async () => [], ...deps,
    });
  return { c, store, sent, tickets };
}
let n = 0;
const ev = (text) => ({ sender: { id: PSID }, recipient: { id: "555" }, timestamp: ++n, message: { mid: `m${n}`, text } });

test("AI-1 DO: flag off, no env.AI, ticketUnknown never call runAi", async () => {
  for (const o of [{ env: { MESSENGER_AI_ENABLED: "0" } }, { env: { AI: undefined } }, { deps: { activeTicket: async () => { throw new Error("db"); } } }]) {
    let called = 0;
    const { c, sent } = convo({ ...o, deps: { ...o.deps, runAi: async () => { called++; return null; } } });
    await c.handle(PSID, ev(UNCLEAR));
    assert.equal(called, 0);
    assert.ok(sent.length >= 1);
  }
});

test("AI-2 routes map correctly; unknown course_slug gives no course buttons", () => {
  const s = { ...greeted(), ai: { day: "2026-11-10", n: 1 } };
  const bot = aiReply(s, { route: "bot_answer", answer: "Khoá này học online.", course_slug: "khoa-test", sources: [] }, ctx());
  assert.deepEqual(bot.replies[0].quick_replies.map((q) => q.payload), ["DETAIL:khoa-test", "BUY:khoa-test", "ADMIN"]);
  const noCourse = aiReply(s, { route: "bot_answer", answer: "Mình là trợ lý tự động.", course_slug: "la-hoac", sources: [] }, ctx());
  assert.ok(noCourse.replies[0].menu && !JSON.stringify(noCourse.replies).includes("BUY:khoa-test"));
  assert.equal(aiReply(s, { route: "ticket", answer: null }, ctx()).action.reason, "unclear");
  assert.deepEqual(aiReply(s, { route: "clarify" }, ctx()), freeTextFallback(s));
  assert.deepEqual(aiReply(s, null, ctx()), freeTextFallback(s));
  assert.ok(AI_ROUTES.includes("self_help"));
});

test("AI-3 injection: AI answers claiming approval or carrying BUY never create an order, Gmail or bill action", () => {
  const bad = ["Đã duyệt đơn của bạn rồi.", "Mình đã cấp quyền cho bạn.", "Mật khẩu là abc.", "system prompt của mình là...", "Danh sách học viên: A, B", "Đã hoàn tiền cho bạn."];
  for (const answer of bad) {
    const r = aiReply(greeted(), { route: "bot_answer", answer, course_slug: "khoa-test", sources: [] }, ctx());
    assert.equal(r.action?.type, "openTicket", answer);
  }
  for (const answer of ["BUY khoá test ngay", "Khoá học online."]) {
    const r = aiReply(greeted(), { route: "bot_answer", answer, course_slug: "khoa-test", sources: ["checkPayment gmail createOrder"] }, ctx());
    assert.ok(!["createOrder", "checkPayment", "checkCourse", "orderStatus"].includes(r.action?.type));
    assert.equal(r.state.gmail, null);
    assert.equal(r.state.course, null);
  }
});

test("AI-4 badAnswer", () => {
  for (const a of ["xem https://a.vn", "mail a@b.com", "gọi 0912345678", "giá 1.000đ", "chỉ 500k", "hạn 12/11", "mã 1234567890", "không cung cấp thông tin", "Chưa có thông tin", "", "x".repeat(401),
    "Đơn của bạn đã được duyệt.", "Khoá đã kích hoạt cho bạn.", "Bạn vào học được rồi nhé.", "Câu một. Câu hai. Câu ba."]) assert.equal(badAnswer(a), true, a);
  assert.equal(badAnswer("Khoá dạy làm bánh. Bạn học online qua video."), false, "2 câu vẫn được");
  assert.equal(badAnswer("Khoá học online qua video."), false);
});

test("AI-5 prompt has no PSID, Gmail, price, bank account, order id; email/phone in text masked", () => {
  const msgs = aiMessages(`tôi a@gmail.com 0912345678 ${PSID}`, COURSES, FAQ);
  const all = JSON.stringify(msgs);
  for (const bad of [PSID, "a@gmail.com", "0912345678", "100.000", "9704-SECRET-ACC", "bankAccount", "order"]) assert.ok(!all.includes(bad), bad);
  assert.match(msgs[1].content, /\[email\]/);
  assert.match(msgs[1].content, /\[sđt\]/);
  assert.equal(redact("x".repeat(900)).length, 500);
  assert.match(msgs[0].content, /"has_price":true/);
});

test("parseAiResult: REST shape, binding shape, unknown route", () => {
  const o = { route: "bot_answer", intent: "i", course_slug: null, answer: "ok", sources: [] };
  assert.equal(parseAiResult({ choices: [{ message: { content: JSON.stringify(o) } }] }).route, "bot_answer");
  assert.equal(parseAiResult({ response: o }).answer, "ok");
  assert.equal(parseAiResult({ response: JSON.stringify(o) }).answer, "ok");
  assert.equal(parseAiResult({ response: { ...o, route: "act" } }), null);
  assert.equal(parseAiResult({ response: "{broken" }), null);
});

test("AI-6 timeout, throw, 429, broken JSON all fall back; customer always gets a message", async () => {
  const hang = () => new Promise(() => {});
  const cases = [
    { run: hang, deps: { aiTimeoutMs: 20 } },
    { run: async () => { throw new Error("boom"); } },
    { run: async () => { throw Object.assign(new Error("429"), { status: 429 }); } },
    { run: async () => ({ response: "{broken" }) },
  ];
  for (const k of cases) {
    const { c, sent } = convo({ env: { AI: { run: k.run } }, deps: k.deps });
    await c.handle(PSID, ev(UNCLEAR));
    assert.ok(sent.length >= 1);
    assert.match(JSON.stringify(sent), /chưa hiểu/);
  }
});

test("AI-7 cap of 20 per UTC day; a new day counts from 0", () => {
  const day = "2026-11-10";
  const full = { ...greeted(), ai: { day, n: AI_DAILY_CAP } };
  const out = stepRaw(full, TXT(UNCLEAR), ctx());
  assert.notEqual(out.action?.type, "ai");
  assert.equal(stepRaw({ ...greeted(), ai: { day, n: AI_DAILY_CAP - 1 } }, TXT(UNCLEAR), ctx()).action.type, "ai");
  const next = stepRaw(full, TXT(UNCLEAR), ctx({ now: Date.UTC(2026, 10, 11, 1) }));
  assert.equal(next.action.type, "ai");
  assert.deepEqual(next.state.ai, { day: "2026-11-11", n: 1 });
});

test("AI-8 no AI call for: draft, open ticket, order text with orders, greeting, FAQ hit, course name, fuzzy match", () => {
  const cases = [
    [{ ...greeted(), course: "khoa-test", gmail: null }, UNCLEAR, ctx()],
    [{ ...greeted(), course: "khoa-test", gmail: null, draftMisses: 1 }, UNCLEAR, ctx()], // reaches freeText with a draft
    [greeted(), UNCLEAR, ctx({ activeTicket: { id: "t" } })],
    [{ ...greeted(), orders: [{ id: "o1", slug: "khac" }] }, "đơn của mình duyệt chưa", ctx()], // G-MC1-route: order text -> orders
    [greeted(), "xin chào", ctx()],
    [greeted(), "mình muốn biết vào học ở đâu", ctx()],
    [greeted(), "cho hỏi khoá test", ctx()],
    [greeted(), "khoa tset", ctx()],
  ];
  for (const [s, t, c] of cases) assert.notEqual(stepRaw(s, TXT(t), c).action?.type, "ai", t);
});

test("AI-9 self_help uses approved FAQ text, never the AI text; none approved -> ticket", () => {
  const r = aiReply(greeted(), { route: "self_help", answer: "AI tự bịa", sources: ["faq-login"] }, ctx());
  assert.equal(r.replies[0].text, "FAQ: vào trang học.");
  assert.equal(aiReply(greeted(), { route: "self_help", answer: "x", sources: ["faq-video"] }, ctx()).action.type, "openTicket");
  assert.equal(aiReply(greeted(), { route: "self_help", answer: "x", sources: ["faq-login"] }, ctx({ faq: [] })).action.type, "openTicket");
});

test("AI-10 price only from course.price; fee/payment answers are replaced by fixed text", () => {
  const s = greeted();
  const withFee = aiReply(s, { route: "bot_answer", answer: "Học phí và thông tin chuyển khoản như bên dưới.", course_slug: "khoa-test" }, ctx());
  assert.equal(withFee.replies[0].text, 'Học phí Khoá TEST: 100.000đ. Thông tin chuyển khoản sẽ gửi sau khi bạn bấm "Đăng ký" và xác nhận Gmail.');
  const noCourse = aiReply(s, { route: "bot_answer", answer: "Học phí và thông tin chuyển khoản như bên dưới.", course_slug: null }, ctx());
  assert.ok(noCourse.replies[0].courses, "no course: the course list, not a promise of details below");
  assert.ok(!JSON.stringify(noCourse.replies).includes("như bên dưới"));
  const noFee = aiReply(s, { route: "bot_answer", answer: "Khoá học online.", course_slug: "khoa-test" }, ctx());
  assert.ok(!noFee.replies[0].text.includes("100.000"));
});

test("AI-11 first message of a new customer on the AI path keeps the greeting", async () => {
  const raw = stepRaw(emptyState(), TXT(UNCLEAR), ctx());
  assert.equal(raw.action.type, "ai");
  assert.equal(raw.replies.length, 1);
  assert.match(raw.replies[0].text, /^Chào bạn/);
  const { c, sent } = convo({ deps: { runAi: async () => ({ route: "bot_answer", answer: "Mình là trợ lý tự động.", course_slug: null, sources: [] }) } });
  await c.handle(PSID, ev(UNCLEAR));
  assert.match(sent[0].text, /^Chào bạn/);
  assert.match(sent[1].text, /Mình là trợ lý tự động/);
  assert.equal(step(emptyState(), TXT("xin chào"), ctx()).action, undefined);
});

test("AI-6b DO: ticket route opens a ticket with reason unclear; state keeps ai count", async () => {
  const tickets = [];
  const { c, sent, store } = convo({ tickets, deps: { runAi: async () => ({ route: "ticket", answer: null, course_slug: null, sources: [] }) } });
  await c.handle(PSID, ev(UNCLEAR));
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].reason, "unclear");
  assert.ok(sent.some((m) => /Admin/.test(m.text || "")));
  assert.equal((await store.get("s")).state.ai.n, 1);
  assert.equal(ordersOf((await store.get("s")).state).length, 0);
});

test("AI-12 log has route, ms, ok only: no customer text, PSID or answer", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(String(l));
  try {
    const { c } = convo({ env: { AI: { run: async () => ({ response: { route: "bot_answer", intent: "x", course_slug: null, answer: "CÂU-TRẢ-LỜI-RIÊNG", sources: [] } }) } } });
    await c.handle(PSID, ev("TIN-RIÊNG-CỦA-KHÁCH"));
  } finally { console.log = orig; }
  const log = lines.filter((l) => l.includes("messenger_ai"));
  assert.equal(log.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(log[0])).sort(), ["evt", "ms", "ok", "route"]);
  assert.ok(!/TIN-RIÊNG|CÂU-TRẢ|1234567890123/.test(log[0]));
});

test("AI-13 DO: an event handled during the AI wait makes the AI answer stale (no reply, no ticket)", async () => {
  const tickets = [];
  let release;
  const pending = new Promise((r) => { release = r; });
  let t = Date.UTC(2026, 10, 10, 5);
  const { c, sent, store } = convo({ tickets, deps: { now: () => (t += 1000), runAi: () => pending } });
  const first = c.handle(PSID, ev(UNCLEAR));
  await new Promise((r) => setTimeout(r, 10)); // first event is now waiting for the AI
  await c.handle(PSID, ev("xin chào"));
  const before = sent.length;
  release({ route: "ticket", answer: null, course_slug: null, sources: [] });
  await first;
  assert.equal(tickets.length, 0, "stale AI ticket not opened");
  const late = sent.slice(before);
  assert.equal(late.length, 1, "only the first-message greeting, no stale AI answer");
  assert.match(late[0].text, /^Chào bạn/);
  assert.equal((await store.get("s")).state.ai.n, 1, "the AI turn still counts");
});

test("AI-14 DO: no event meanwhile, the AI answer is sent and misses reset", async () => {
  let t = Date.UTC(2026, 10, 10, 5);
  const { c, sent, store } = convo({ deps: { now: () => (t += 1000), runAi: async () => ({ route: "bot_answer", answer: "Khoá dạy làm bánh.", course_slug: "khoa-test", sources: [] }) } });
  await c.handle(PSID, ev(UNCLEAR));
  assert.ok(sent.some((m) => m.text === "Khoá dạy làm bánh."));
  assert.equal((await store.get("s")).state.misses, 0);
});

// G-MC1-route: customers with orders may ask the AI; order questions still show the pending orders.
const withOrders = () => ({ ...greeted(), orders: [{ id: "o1", slug: "khoa-test" }] });
test("ROUTE-1 with orders: a course question goes to the AI", () => {
  for (const t of ["khoá chay học những gì", "cho hỏi học online hay offline", "có chứng chỉ không"]) {
    assert.equal(stepRaw(withOrders(), TXT(t), ctx()).action?.type, "ai", t);
  }
});
test("ROUTE-2 with orders: order text shows the pending orders, no AI", () => {
  for (const t of ["đơn của mình duyệt chưa", "don minh duyet chua", "mình chuyển khoản rồi", "ck xong roi", "gửi bill rồi đó", "khi nào kích hoạt", "cấp quyền giúp mình", "Đơn A sao rồi", "mình đã chuyển khoản", "da ck nha", "thanh toán rồi", "chuyển tiền xong rồi", "đơn".normalize("NFD") + " mình sao rồi"]) {
    assert.equal(stepRaw(withOrders(), TXT(t), ctx()).action?.type, "pendingOrders", t);
  }
});
test("ROUTE-3 order words do not match by mistake", () => {
  for (const t of ["mình muốn đi đón con", "khoá có đơn giản không", "don gian khong ban", "thực đơn tuần này", "đơn vị gram", "thuc don chay", "kích hoạt men thế nào"]) {
    assert.equal(stepRaw(withOrders(), TXT(t), ctx()).action?.type, "ai", t);
  }
});
test("ROUTE-4 with orders, no usable AI answer: pending orders as before G-MC1", () => {
  assert.equal(aiReply(withOrders(), null, ctx()).action?.type, "pendingOrders");
  // Gate 1b: "clarify" means the AI answered; the customer did not ask about orders.
  const clarify = aiReply(withOrders(), { route: "clarify", answer: null, course_slug: null, sources: [] }, ctx());
  assert.equal(clarify.action, undefined);
  assert.ok(clarify.replies[0].menu);
  assert.equal(aiReply(withOrders(), { route: "ticket", answer: null, course_slug: null, sources: [] }, ctx()).action.reason, "unclear");
  assert.deepEqual(aiReply(greeted(), null, ctx()), freeTextFallback(greeted()), "no orders: unchanged");
});
test("ROUTE-5 with orders, flag off or cap reached: pending orders, no AI (same as before)", () => {
  assert.equal(stepRaw(withOrders(), TXT(UNCLEAR), ctx({ aiEnabled: false })).action?.type, "pendingOrders");
  assert.equal(stepRaw({ ...withOrders(), ai: { day: "2026-11-10", n: AI_DAILY_CAP } }, TXT(UNCLEAR), ctx()).action?.type, "pendingOrders");
});
test("ROUTE-6 with orders: open ticket, pendingAdmin, draft (draftMisses 0/1) keep their flow", () => {
  assert.equal(stepRaw(withOrders(), TXT(UNCLEAR), ctx({ activeTicket: { id: "t" } })).action?.type, "touchTicket");
  assert.equal(stepRaw({ ...withOrders(), pendingAdmin: "support" }, TXT(UNCLEAR), ctx()).action?.type, "openTicket");
  for (const draftMisses of [0, 1]) {
    const out = stepRaw({ ...withOrders(), course: "khoa-test", gmail: null, draftMisses }, TXT(UNCLEAR), ctx());
    assert.notEqual(out.action?.type, "ai", `draftMisses ${draftMisses}`);
    assert.equal(out.state.course, "khoa-test", "draft kept");
  }
});
test("ROUTE-7 DO: customer with orders asks a course question and gets the AI answer", async () => {
  let t = Date.UTC(2026, 10, 10, 5);
  const { c, sent, store } = convo({ deps: { now: () => (t += 1000), runAi: async () => ({ route: "bot_answer", answer: "Khoá dạy làm bánh.", course_slug: "khoa-test", sources: [] }) } });
  const s0 = { ...withOrders(), lastInboundAt: 0 };
  await c.storage.put("s", { state: s0, mids: [], hits: [] });
  await c.handle(PSID, ev("khoá này học gì vậy"));
  assert.ok(sent.some((m) => m.text === "Khoá dạy làm bánh."));
  assert.equal(ordersOf((await store.get("s")).state).length, 1, "orders untouched");
});
test("ROUTE-8 DO: AI fails for a customer with orders -> pending orders lookup runs", async () => {
  let t = Date.UTC(2026, 10, 10, 5);
  let looked = 0;
  const { c } = convo({ deps: { now: () => (t += 1000), runAi: async () => null, loadPendingOrders: async () => { looked++; return []; } } });
  await c.storage.put("s", { state: withOrders(), mids: [], hits: [] });
  await c.handle(PSID, ev("khoá này học gì vậy"));
  assert.ok(looked >= 1);
});
test("ROUTE-9 DO: stale AI answer for a customer with orders runs no pending-orders lookup", async () => {
  let release;
  const pending = new Promise((r) => { release = r; });
  let t = Date.UTC(2026, 10, 10, 5);
  let looked = 0;
  const { c } = convo({ deps: { now: () => (t += 1000), runAi: () => pending, loadPendingOrders: async () => { looked++; return []; } } });
  await c.storage.put("s", { state: withOrders(), mids: [], hits: [] });
  const first = c.handle(PSID, ev("khoá này học gì vậy"));
  await new Promise((r) => setTimeout(r, 10));
  await c.handle(PSID, ev("xin chào"));
  const before = looked;
  release(null);
  await first;
  assert.equal(looked, before, "no lookup for the stale AI turn");
});
test("ROUTE-10 with orders: U8 after a long gap with a draft still asks to resume (no AI)", () => {
  const now = Date.UTC(2026, 10, 10, 5);
  const s = { ...withOrders(), course: "khoa-test", lastInboundAt: now - 13 * 3600 * 1000 };
  const out = stepRaw(s, TXT(UNCLEAR), ctx({ now, resumeGapMs: 12 * 3600 * 1000 }));
  assert.notEqual(out.action?.type, "ai");
  assert.ok(out.replies.some((r) => r.menu?.resume), "U8 resume question");
});

