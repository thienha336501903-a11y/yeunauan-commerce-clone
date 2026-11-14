// G3: the AI consults; a ticket (which silences the bot) is only for what needs a person. Catalogue facts come from code.
import test from "node:test";
import assert from "node:assert/strict";
import { stepRaw, emptyState, aiReply } from "../utils/messenger/bot.js";
import { AI_ROUTES, parseAiResult, systemPrompt, buildAiPack } from "../utils/messenger/ai.js";
import { MessengerConversation } from "../cloudflare/commerce-worker/src/messenger.js";

const PSID = "1234567890123";
const NOW = Date.UTC(2026, 10, 11, 6);
const course = (slug, price) => ({ slug, title: `Khoá ${slug}`, price, subtitle: "", description: "", bankName: "T", bankAccount: "0", bankOwner: "T", transferNote: "N" });
const A = course("a", "1.000.000đ"), B = course("b", "500.000đ"), C = course("c", "700,000 VND");
const ctx = (extra = {}) => ({ now: NOW, courses: [A, B, C], ticketsEnabled: true, faq: [], activeTicket: null, aiEnabled: true, ...extra });
const G = (extra = {}) => ({ ...emptyState(), greeted: true, lastInboundAt: NOW - 1000, ...extra });
const ai = (route, intent = "other", answer = null, course_slug = null) => ({ route, intent, answer, course_slug, sources: [] });
const payloads = (m) => [...(m.attachment?.payload?.buttons || []), ...(m.quick_replies || [])].map((q) => q.payload);
const textOf = (m) => m.text ?? m.attachment?.payload?.text;
const OFFER = /muốn Admin hỗ trợ thêm/;

test("G3-1 offer_admin asks first: no ticket, the customer decides", () => {
  const out = aiReply(G({ misses: 1 }), ai("offer_admin"), ctx());
  assert.equal(out.action, undefined);
  assert.match(out.replies[0].text, OFFER);
  assert.deepEqual(payloads(out.replies[0]), ["HUMAN", "LIST", "MENU"]);
  assert.equal(out.state.misses, 0);
});

test("G3-2 tapping 'Chat với Admin' opens the ticket", () => {
  const out = stepRaw(G(), { kind: "text", text: "Chat với Admin", payload: "HUMAN" }, ctx());
  assert.equal(out.action.type, "openTicket");
  assert.equal(out.action.reason, "human");
});

test("G3-3 route ticket still opens a ticket at once", () => {
  assert.equal(aiReply(G(), ai("ticket"), ctx()).action.type, "openTicket");
});

test("G3-4 an answer the filter refuses is not sent and does not open a ticket", () => {
  for (const answer of ["Giá 500k nhé.", "Đã duyệt đơn của bạn.", "Vào https://x.vn nhé.", "Dữ liệu không cung cấp thông tin này.", null]) {
    const out = aiReply(G(), ai("bot_answer", "other", answer), ctx());
    assert.equal(out.action, undefined, String(answer));
    assert.match(out.replies[0].text, OFFER, String(answer));
    if (answer) assert.ok(!out.replies[0].text.includes(answer));
  }
});

test("G3-5 catalog and newest are answered by code, whatever the model wrote", () => {
  const list = aiReply(G(), ai("bot_answer", "catalog", "Khoá X rất ngon, 99k"), ctx());
  assert.ok(list.replies[0].courses);
  assert.ok(!JSON.stringify(list.replies).includes("99k"));
  const newest = aiReply(G(), ai("bot_answer", "newest"), ctx());
  assert.match(newest.replies[0].courses.intro, /chưa có thông tin khóa nào mới nhất/);
});

test("G3-6 cheapest: one winner gets its price from the record, with buttons", () => {
  const out = aiReply(G(), ai("bot_answer", "cheapest"), ctx());
  assert.equal(out.action, undefined);
  assert.equal(out.replies[0].text, "Học phí Khoá b: 500.000đ.");
  assert.deepEqual(payloads(out.replies[0]), ["DETAIL:b", "BUY:b", "ADMIN"]);
});

test("G3-7 cheapest: ties name the price; an amount that cannot be compared gives the list", () => {
  const tie = aiReply(G(), ai("bot_answer", "cheapest"), ctx({ courses: [course("x", "1.000đ (TEST)"), course("y", "1,000đ")] }));
  assert.match(tie.replies[0].courses.intro, /thấp nhất hiện là 1\.000đ \(TEST\), có 2 khóa/);
  for (const p of ["500k", "Liên hệ", ""]) {
    const out = aiReply(G(), ai("bot_answer", "cheapest"), ctx({ courses: [A, course("z", p)] }));
    assert.match(out.replies[0].courses.intro, /xem học phí của từng khóa/, p);
  }
});

test("G3-8 no facts branch for an unknown intent or another route", () => {
  const out = aiReply(G(), ai("bot_answer", "recommend", "Bạn muốn học để làm gì ạ?"), ctx());
  assert.equal(out.replies[0].menu.intro, "Bạn muốn học để làm gì ạ? ");
  assert.equal(aiReply(G(), ai("ticket", "cheapest"), ctx()).action.type, "openTicket", "ticket wins over the intent");
  assert.match(aiReply(G(), ai("offer_admin", "catalog"), ctx()).replies[0].text, OFFER);
});

test("G3-9 nothing from the AI path opens a draft or asks for Gmail, with or without orders", () => {
  const orders = [{ id: "o", slug: "a" }];
  for (const state of [G(), G({ orders })]) for (const a of [ai("offer_admin"), ai("bot_answer", "catalog"), ai("bot_answer", "cheapest"), ai("bot_answer", "newest")]) {
    const out = aiReply(state, a, ctx());
    assert.equal(out.state.course, null);
    assert.ok(!["createOrder", "checkPayment", "checkCourse", "orderStatus", "pendingOrders"].includes(out.action?.type));
    assert.ok(!/gmail/i.test(JSON.stringify(out.replies)));
  }
});

test("G3-10 schema and prompt: offer_admin exists, no price in the prompt, ticket is restricted", () => {
  assert.ok(AI_ROUTES.includes("offer_admin"));
  assert.equal(parseAiResult({ response: { route: "offer_admin", intent: "x", course_slug: null, answer: null, sources: [] } }).route, "offer_admin");
  const p = systemPrompt(buildAiPack([A, B], []));
  assert.ok(!p.includes("500.000") && !p.includes("1.000.000"));
  assert.match(p, /"ticket": CHỈ khi cần người xử lý/);
});

function convo({ env = {}, deps = {} } = {}) {
  const store = new Map([["s", { state: G(), mids: [], hits: [] }]]);
  const calls = [];
  let t = NOW;
  const c = new MessengerConversation({ storage: { async get(k) { return structuredClone(store.get(k)); }, async put(k, v) { store.set(k, structuredClone(v)); } } },
    { META_PAGE_ACCESS_TOKEN: "t", META_APP_ID: "777", META_PAGE_ID: "555", MESSENGER_TICKETS_ENABLED: "1", MESSENGER_AI_ENABLED: "1", AI: { run: async () => ({ response: { route: "offer_admin", intent: "other", course_slug: null, answer: null, sources: [] } }) }, ...env },
    { fetchImpl: async (_u, init) => { calls.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }, now: () => (t += 1000), loadCourses: async () => [A], loadFaq: () => [], activeTicket: async () => null, touchTicket: async () => {}, openTicket: async () => { throw new Error("no ticket expected"); }, loadCourseOrders: async () => [], loadPendingOrders: async () => [], ...deps });
  return { c, calls };
}
const ev = () => ({ sender: { id: PSID }, recipient: { id: "555" }, timestamp: 1, message: { mid: `m${Math.random()}`, text: "có chứng chỉ không" } });

test("G3-11 DO: typing_on goes first, to this customer, then the answer; no ticket", async () => {
  const { c, calls } = convo();
  await c.handle(PSID, ev());
  assert.deepEqual(calls[0], { recipient: { id: PSID }, sender_action: "typing_on" });
  assert.match(calls.at(-1).message.text, OFFER);
});

test("G3-12 DO: a failing typing_on never affects the reply", async () => {
  let n = 0;
  const sent = [];
  const fetchImpl = async (_u, init) => { if (++n === 1) throw new Error("meta down"); sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); };
  const { c } = convo({ deps: { fetchImpl } });
  await c.handle(PSID, ev());
  assert.match(sent.at(-1).message.text, OFFER);
});

test("G3-13 DO: no typing when the AI is off or a ticket is open", async () => {
  const off = convo({ env: { MESSENGER_AI_ENABLED: "0" }, deps: { openTicket: async () => ({ ok: true }) } });
  await off.c.handle(PSID, ev());
  assert.ok(!off.calls.some((b) => b.sender_action));
  const open = convo({ deps: { activeTicket: async () => ({ id: "t" }) } });
  await open.c.handle(PSID, ev());
  assert.equal(open.calls.length, 0);
});

test("G3-14 cheapest only compares plain amounts", () => {
  for (const p of ["500.000,00đ", "1,000.00 VND", "100 đô", "500.000đ/tháng", "1.000.000đ còn 500.000đ", "1.000 đồng/buổi"]) {
    const out = aiReply(G(), ai("bot_answer", "cheapest"), ctx({ courses: [A, course("z", p)] }));
    assert.match(out.replies[0].courses.intro, /xem học phí của từng khóa/, p);
  }
  for (const [p, want] of [["1.000đ (TEST)", "1.000đ (TEST)"], ["1,000đ", "1,000đ"], ["2.000 VNĐ", "2.000 VNĐ"], ["300000đ", "300000đ"]]) {
    const out = aiReply(G(), ai("bot_answer", "cheapest"), ctx({ courses: [course("z", p), course("y", "9.000.000đ")] }));
    assert.equal(out.replies[0].text, `Học phí Khoá z: ${want}.`);
  }
});

test("G3-15 false promises are refused; a refused answer is logged without its text", async () => {
  for (const answer of ["Mình đã nhận được tiền của bạn.", "Bill hợp lệ nhé.", "Đơn đã duyệt xong."]) assert.equal(aiReply(G(), ai("bot_answer", "other", answer), ctx()).filtered, true, answer);
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(String(l));
  try {
    const { c } = convo({ deps: { runAi: async () => ai("bot_answer", "other", "ĐÃ-DUYỆT đã duyệt") } });
    await c.handle(PSID, ev());
  } finally { console.log = orig; }
  assert.deepEqual(lines.filter((l) => l.includes("filtered")), ['{"evt":"messenger_ai_filtered"}']);
});
