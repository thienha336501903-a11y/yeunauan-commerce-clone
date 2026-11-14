// G-MC1-intent: a sentence that mentions a course is not a wish to buy it. Gmail is asked only on a clear wish to register.
import test from "node:test";
import assert from "node:assert/strict";
import { stepRaw, emptyState, aiReply, detailReplies } from "../utils/messenger/bot.js";
import { aiMessages } from "../utils/messenger/ai.js";
import { MessengerConversation, loadCourses } from "../cloudflare/commerce-worker/src/messenger.js";

const course = (slug, title, extra = {}) => ({ slug, title, subtitle: "", description: "Dữ liệu tổng hợp cho Staging.", price: "1.000đ (TEST)", featured: false, bankName: "T", bankAccount: "0", bankOwner: "T", transferNote: "N", ...extra });
const B = course("stg-khoa-b", "STAGING Khóa B – Làm bánh");
const C = course("stg-khoa-c", "STAGING Khóa C – Món chay", { description: "Học 10 món chay cơ bản.", contentApproved: true });
const NOW = Date.UTC(2026, 10, 11, 4);
const ctx = (extra = {}) => ({ now: NOW, courses: [B, C], ticketsEnabled: true, faq: [], activeTicket: null, aiEnabled: true, resumeGapMs: 43200000, ...extra });
const G = () => ({ ...emptyState(), greeted: true, lastInboundAt: NOW - 1000 });
const withOrder = () => ({ ...G(), orders: [{ id: "o1", slug: "stg-khoa-a" }] });
const txt = (text) => ({ kind: "text", text });
const qr = (payload) => ({ kind: "text", text: "Đúng", payload });
const payloads = (m) => [...(m.attachment?.payload?.buttons || []), ...(m.quick_replies || [])].map((q) => q.payload);
const textOf = (m) => m.text ?? m.attachment?.payload?.text;
const NO_INFO = /chưa có đủ thông tin chi tiết về nội dung khóa STAGING Khóa B/;
const EXACT = "STAGING Khóa B – Làm bánh";
const noBuyFlow = (out, msg) => {
  assert.notEqual(out.action?.type, "checkCourse", msg);
  assert.equal(out.state.course, null, msg);
  assert.ok(!/gmail/i.test(JSON.stringify(out.replies)), msg);
};

test("INT-1 typo or partial name + question: 'Đúng' keeps the topic, no buy flow", () => {
  const cases = [
    // G-LIVE-ux F-A6: "bnah" (4 letters) is no longer a typo of "bánh", so the typo rows use the exact words.
    // G-LIVE-ux F-A7: content / lessons questions answer with the [Xem chi tiết] card ("Đúng" = DETAIL).
    ["khóa làm bánh học những gì", "content"], ["khoa lam banh day nhung gi", "content"],
    ["khoa lam banh co nhung bai nao", "lessons"], ["khoá làm bánh có bao nhiêu bài", "lessons"],
    ["khoá làm bánh giá bao nhiêu", "price"],
  ];
  for (const state of [G(), withOrder()]) for (const [t, topic] of cases) {
    const out = stepRaw(state, txt(t), ctx());
    noBuyFlow(out, t);
    if (topic === "price") assert.deepEqual(payloads(out.replies[0]), [`INFO:stg-khoa-b:${topic}`, "LIST"], t);
    else assert.deepEqual(payloads(out.replies[0]), ["DETAIL:stg-khoa-b", "LIST"], t); // partial name: "Đúng" = the card
  }
});

test("INT-2 exact name + question answers directly, never opens the buy flow", () => {
  // G-LIVE-ux F-A7: content / lessons -> the detail card, not "chưa có đủ thông tin".
  const content = stepRaw(G(), txt(`${EXACT} học những gì`), ctx());
  noBuyFlow(content);
  assert.deepEqual(content.replies, detailReplies(B));
  const lessons = stepRaw(G(), txt(`${EXACT} có những bài nào`), ctx());
  noBuyFlow(lessons);
  assert.deepEqual(lessons.replies, detailReplies(B));
  const price = stepRaw(G(), txt(`${EXACT} giá bao nhiêu`), ctx());
  noBuyFlow(price);
  assert.equal(price.replies[0].text, `Học phí ${EXACT}: 1.000đ (TEST).`);
});

test("INT-3 clear wish to register: exact name -> buy flow, typo -> 'Đúng' = BUY", () => {
  for (const t of [`tôi muốn đăng ký ${EXACT}`, `mua ${EXACT}`, `dk ${EXACT}`]) assert.equal(stepRaw(G(), txt(t), ctx()).action?.type, "checkCourse", t);
  for (const t of ["tôi muốn đăng ký khoá làm bánh", "mình muốn mua khoá làm bánh", "mua khoa lam banh", "dk khoa lam banh"]) {
    const out = stepRaw(G(), txt(t), ctx());
    assert.deepEqual(payloads(out.replies[0]), ["BUY:stg-khoa-b", "LIST"], t);
  }
});

test("INT-4 'Đúng' (INFO) answers the original question: no action, no draft, no Gmail", () => {
  for (const [p, re] of [["INFO:stg-khoa-b:content", NO_INFO], ["INFO:stg-khoa-b:lessons", NO_INFO], ["INFO:stg-khoa-b:price", /^Học phí STAGING Khóa B – Làm bánh: 1\.000đ \(TEST\)\.$/]]) {
    const out = stepRaw(G(), qr(p), ctx());
    assert.equal(out.action, undefined, p);
    noBuyFlow(out, p);
    assert.match(out.replies[0].text, re, p);
  }
  const general = stepRaw(G(), qr("INFO:stg-khoa-b:general"), ctx());
  assert.deepEqual(general.replies, detailReplies(B));
  assert.deepEqual(stepRaw(G(), qr("INFO:stg-khoa-b:lạ"), ctx()).replies, detailReplies(B), "unknown topic: the card");
});

test("INT-5 no approved content: says so with Admin button, no ticket, no description. Approved: the description", () => {
  const none = stepRaw(G(), qr("INFO:stg-khoa-b:content"), ctx());
  assert.deepEqual(payloads(none.replies[0]), ["ADMIN", "BUY:stg-khoa-b", "LIST"]);
  assert.equal(none.action, undefined, "no ticket opened by itself");
  assert.ok(!none.replies[0].text.includes("Dữ liệu tổng hợp"));
  const ok = stepRaw(G(), qr("INFO:stg-khoa-c:content"), ctx());
  assert.match(ok.replies[0].text, /Học 10 món chay cơ bản\./);
  assert.deepEqual(payloads(ok.replies[0]), ["DETAIL:stg-khoa-c", "BUY:stg-khoa-c", "ADMIN"]);
  assert.match(stepRaw(G(), qr("INFO:stg-khoa-c:lessons"), ctx()).replies[0].text, /chưa có đủ thông tin/, "no lesson list in the data, even when approved");
});

test("INT-6 a question beats 'đăng ký'; how-to and negatives are not a wish to buy; other words are not 'mua'", () => {
  assert.deepEqual(payloads(stepRaw(G(), txt("đăng ký khoá làm bánh giá bao nhiêu"), ctx()).replies[0]), ["INFO:stg-khoa-b:price", "LIST"]);
  for (const t of ["đăng ký khoá làm bánh thế nào", "chưa muốn mua khoá làm bánh", "mùa này có khoá làm bánh không", "trời mưa có khoá làm bánh không"]) {
    const out = stepRaw(G(), txt(t), ctx());
    noBuyFlow(out, t);
    assert.equal(out.action?.type, "ai", t);
  }
  const noAi = stepRaw(G(), txt("chưa muốn mua khoá làm bánh"), ctx({ aiEnabled: false }));
  assert.deepEqual(payloads(noAi.replies[0]), ["INFO:stg-khoa-b:general", "LIST"]);
  assert.equal(stepRaw(G(), txt("khoá làm bánh dùng gia vị nào"), ctx()).action?.type, "ai", "gia vị is not a price");
});

test("INT-7 with orders: an order question beats a course match in the same sentence", () => {
  for (const t of ["đơn khoá làm bánh duyệt chưa", "khoá làm bánh mình chuyển khoản rồi"]) assert.equal(stepRaw(withOrder(), txt(t), ctx()).action?.type, "myOrders", t); // G-LIVE-ux F-A1
  assert.equal(stepRaw(G(), txt("đơn khoá làm bánh duyệt chưa"), ctx()).action?.type, "myOrders", "no orders: T8 invites Admin");
});

test("INT-8 other question with a course: AI gets the course as a hint; no usable answer -> card or 'this course?'", () => {
  const typo = stepRaw(G(), txt("khoá làm bánh có chứng chỉ không"), ctx());
  assert.equal(typo.action.type, "ai");
  assert.deepEqual(typo.action.match, { slug: "stg-khoa-b", exact: false });
  noBuyFlow(aiReply(typo.state, null, ctx(), typo.action.match));
  assert.deepEqual(payloads(aiReply(typo.state, null, ctx(), typo.action.match).replies[0]), ["INFO:stg-khoa-b:general", "LIST"]);
  const exact = stepRaw(withOrder(), txt(`${EXACT} có chứng chỉ không`), ctx());
  assert.deepEqual(exact.action.match, { slug: "stg-khoa-b", exact: true });
  assert.deepEqual(aiReply(exact.state, { route: "clarify" }, ctx(), exact.action.match).replies, detailReplies(B));
  assert.equal(aiReply(exact.state, { route: "ticket", answer: null }, ctx(), exact.action.match).action.reason, "unclear");
  for (const c of [ctx({ aiEnabled: false }), ctx({ aiEnabled: undefined })]) {
    const off = stepRaw(G(), txt(`${EXACT} có chứng chỉ không`), c);
    noBuyFlow(off);
    assert.deepEqual(off.replies, detailReplies(B));
  }
});

test("INT-9 only the course name: card or 'this course?', no AI call, no buy flow", () => {
  const exact = stepRaw(G(), txt(EXACT), ctx());
  assert.equal(exact.action, undefined);
  assert.deepEqual(exact.replies, detailReplies(B));
  // G-LIVE-ux F-A6: a 4-letter typo ("bnah") is no longer matched.
});

test("INT-10 course text reaches the model only when approved", () => {
  const all = JSON.stringify(aiMessages("hỏi", [{ ...B, subtitle: "PHU-DE-CHUA-DUYET", description: "MO-TA-CHUA-DUYET" }, { ...C, subtitle: "PHU-DE-DA-DUYET" }], []));
  assert.ok(!all.includes("MO-TA-CHUA-DUYET") && !all.includes("PHU-DE-CHUA-DUYET"));
  assert.ok(all.includes("Học 10 món chay") && all.includes("PHU-DE-DA-DUYET"));
  assert.ok(all.includes("STAGING Khóa B"), "the title still goes");
});

test("INT-11 INFO: course gone -> list; open draft is kept; U8 treats it like DETAIL", () => {
  const gone = stepRaw(G(), qr("INFO:khoa-het-ban:content"), ctx());
  assert.ok(gone.replies.some((r) => r.courses));
  const draft = { ...G(), course: "stg-khoa-b", gmail: "a@gmail.com" };
  assert.equal(stepRaw(draft, qr("INFO:stg-khoa-c:price"), ctx()).state.course, "stg-khoa-b");
  const back = stepRaw({ ...draft, lastInboundAt: NOW - 13 * 3600 * 1000 }, qr("INFO:stg-khoa-c:price"), ctx());
  assert.ok(!back.replies.some((r) => r.menu?.resume), "explicit button, no U8 question");
  assert.equal(back.state.course, "stg-khoa-b");
});

test("INT-12 with a draft: the old paths stay (U4, U5, U9)", () => {
  const draft = { ...G(), course: "stg-khoa-c", gmail: null, draftMisses: 1 };
  const typo = stepRaw(draft, txt("khoá làm banh học gì"), ctx());
  assert.deepEqual(payloads(typo.replies[0]), ["BUY:stg-khoa-b", "LIST"]); // G-LIVE-ux F-A6: "bnah" became "banh" (typos need 5+ letters)
  assert.equal(typo.state.course, "stg-khoa-c");
  const named = stepRaw({ ...draft, draftMisses: 0 }, txt(EXACT), ctx());
  assert.equal(named.state.course, "stg-khoa-c", "the draft is never replaced by typing a name");
});

test("INT-13 first message keeps the greeting on the read-only answer", () => {
  const out = stepRaw(emptyState(), txt(`${EXACT} giá bao nhiêu`), ctx());
  assert.match(out.replies[0].text, /^Chào bạn/);
  assert.match(out.replies[1].text, /^Học phí/);
});

test("INT-14 DO: AI fails on a course question -> the card is sent, no order, no ticket", async () => {
  const store = new Map();
  const sent = [];
  const tickets = [];
  let t = NOW;
  const c = new MessengerConversation({ storage: { async get(k) { return store.has(k) ? structuredClone(store.get(k)) : undefined; }, async put(k, v) { store.set(k, structuredClone(v)); } } },
    { META_PAGE_ACCESS_TOKEN: "t", META_APP_ID: "777", META_PAGE_ID: "555", MESSENGER_TICKETS_ENABLED: "1", MESSENGER_AI_ENABLED: "1", AI: { run: async () => ({}) } },
    { fetchImpl: async (_u, init) => { sent.push(JSON.parse(init.body).message); return new Response("{}", { status: 200 }); }, now: () => (t += 1000), loadCourses: async () => [B, C], loadFaq: () => [], activeTicket: async () => null, openTicket: async (a) => { tickets.push(a); return { ok: true }; }, touchTicket: async () => {}, loadCourseOrders: async () => [], loadPendingOrders: async () => [], createBillOrder: async () => { throw new Error("no order"); }, runAi: async () => null });
  await c.storage.put("s", { state: G(), mids: [], hits: [] });
  await c.handle("1234567890123", { sender: { id: "1234567890123" }, recipient: { id: "555" }, timestamp: 1, message: { mid: "m1", text: `${EXACT} có chứng chỉ không` } });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Học phí: 1\.000đ/);
  assert.equal(tickets.length, 0);
  assert.equal(store.get("s").state.course, null);
});

test("INT-15 loadCourses: contentApproved only when the flag is exactly true", async () => {
  const row = (slug, flag) => ({ slug, title: slug, price: "1", active: true, delivery_mode: "v5", raw_data: { messengerSale: true, bankAccount: "0", ...(flag === undefined ? {} : { messengerContentApproved: flag }) } });
  const data = [row("a", true), row("b", "true"), row("c")];
  const q = { select: () => q, eq: () => q, in: () => q, then: (res) => res({ data, error: null }) };
  const list = await loadCourses({}, { from: () => q });
  assert.deepEqual(list.map((c) => [c.slug, c.contentApproved]).sort(), [["a", true], ["b", false], ["c", false]]);
});

test("INT-16 cancel, already registered, how-to are not a wish to buy (exact name and typo)", () => {
  for (const pre of ["hủy đăng ký", "bỏ đăng ký", "mình đã đăng ký", "cách đăng ký", "hướng dẫn đăng ký", "khi nào đăng ký", "đừng đăng ký"]) {
    const suffix = pre === "mình đã đăng ký" ? " rồi" : "";
    for (const name of [EXACT, "khoá làm bnah"]) {
      const out = stepRaw(G(), txt(`${pre} ${name}${suffix}`), ctx());
      noBuyFlow(out, pre);
      assert.ok(!out.replies.some((r) => payloads(r)[0] === "BUY:stg-khoa-b"), `${pre} / ${name}`);
    }
  }
});

test("INT-17 'gia' and 'chương trình' look-alikes; more content wordings", () => {
  for (const t of ["muốn tham gia khoá làm bánh", "khoá làm bánh có gia hạn không", "khoá làm bánh có giảm giá không", "khoá làm bánh có chuyên gia không"]) {
    assert.equal(stepRaw(G(), txt(t), ctx()).action?.type, "ai", t);
  }
  assert.equal(stepRaw(G(), txt("khoá làm bánh có chương trình khuyến mãi không"), ctx()).action?.type, "ai");
  for (const t of ["khoá làm bánh dạy những món gì", "khoá làm bánh học món gì", "khoá làm bánh gồm những gì"]) {
    assert.deepEqual(payloads(stepRaw(G(), txt(t), ctx()).replies[0]), ["DETAIL:stg-khoa-b", "LIST"], t); // G-LIVE-ux F-A7
  }
});

test("INT-16b 'đã đk', 'đk ... là gì' are not a wish to buy; emoji before the title does not shift the match", () => {
  for (const s of [`mình đã đk ${EXACT}`, `đk ${EXACT} là gì`]) noBuyFlow(stepRaw(G(), txt(s), ctx()), s);
  assert.equal(stepRaw(G(), txt(`❤️❤️ mua ${EXACT}`), ctx()).action?.type, "checkCourse");
});

test("INT-18 words inside an exact course title do not change the intent", () => {
  const K = course("banh-khong-duong", "Bánh không đường");
  const c = ctx({ courses: [K] });
  assert.equal(stepRaw(G(), txt("đăng ký Bánh không đường"), c).action?.type, "checkCourse");
  assert.equal(stepRaw(G(), txt("bánh không đường đăng ký"), c).action?.type, "checkCourse", "typed without capitals");
  assert.equal(stepRaw(G(), txt("Bánh không đường giá bao nhiêu"), c).replies[0].text, "Học phí Bánh không đường: 1.000đ (TEST).");
});
