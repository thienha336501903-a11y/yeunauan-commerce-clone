// Messenger V2 (G-V2-code): 3-button menu, campaign flow, several orders, Admin switches, Admin "send registration".
// Fake DB env for the api/courses.js tests; a data: module runs before the other imports read the env.
import "data:text/javascript,process.env.SUPABASE_URL%3D%3Dprocess.env.SUPABASE_URL%3Bprocess.env.SUPABASE_URL%3Fprocess.env.SUPABASE_URL%3A(process.env.SUPABASE_URL%3D%27http%3A%2F%2Flocalhost%3A1%27)%3Bprocess.env.SUPABASE_SERVICE_ROLE_KEY%7C%7C(process.env.SUPABASE_SERVICE_ROLE_KEY%3D%27test-key%27)";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { step, emptyState, ordersOf, normalizeState, MENU3, TICKET_OK_TEXT, orderCreatedReply, openCourse, switchAsk } from "../utils/messenger/bot.js";
import { MessengerConversation, loadCourses, toEvent, eventId } from "../cloudflare/commerce-worker/src/messenger.js";
import { createHandler } from "../cloudflare/commerce-worker/src/messenger-tickets.js";
import { runCompatHandler } from "../cloudflare/commerce-worker/src/http-compat.js";

const PSID = "1234567890123";
const PAGE = "555";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const A = { slug: "khoa-a", title: "Khóa A", price: "100.000đ", bankName: "VCB", bankAccount: "0123", bankOwner: "X", transferNote: "A", qrImageUrl: "", imageUrl: "https://img.example/a.jpg", featured: false };
const B = { slug: "khoa_b", title: "Khóa B", price: "200.000đ", bankName: "VCB", bankAccount: "0456", bankOwner: "X", transferNote: "B", qrImageUrl: "", imageUrl: "", featured: true };
const COURSES = [B, A];
const ctx = (extra = {}) => ({ now: 1_000_000, courses: COURSES, ticketsEnabled: true, faq: [], activeTicket: null, commerceUrl: "https://shop.example", ...extra });
const txt = (text, payload) => ({ kind: "text", text, ...(payload ? { payload } : {}) });
const pb = (payload) => ({ kind: "postback", payload });
const G = { ...emptyState(), greeted: true };
// The DO answers a checkCourse action from the DB; with no order found it opens the draft, or asks to switch. Same here, without a DB.
const settle = (out, c = ctx()) => {
  const a = out.action;
  if (a?.type !== "checkCourse") return out;
  const course = c.courses.find((x) => x.slug === a.slug);
  if (a.ask && out.state.course && out.state.course !== a.slug) return { ...out, replies: [...out.replies, ...switchAsk(out.state, course, c)] };
  const r = openCourse(a.ref ? { ...out.state, ref: a.ref } : out.state, course, c);
  return { ...out, state: r.state, replies: [...out.replies, ...r.replies] };
};
const payloads = (m) => [...(m.attachment?.payload?.buttons || []), ...(m.quick_replies || [])].map((q) => q.payload);
const textOf = (m) => m.text ?? m.attachment?.payload?.text;

// ---- 1-2 menu and greeting ----
test("menu: exactly 3 buttons, exact titles and payloads, titles <= 20", () => {
  assert.deepEqual(MENU3, [["Đăng ký khóa học", "BUY"], ["Xem khóa đang mở bán", "LIST"], ["Chat với Admin", "ADMIN"]]);
  const out = step(G, txt("hi"), ctx());
  assert.deepEqual(payloads(out.replies.at(-1)), ["BUY", "LIST", "ADMIN"]);
  assert.ok([...out.replies.at(-1).attachment.payload.buttons, ...(out.replies.at(-1).quick_replies || [])].every((q) => q.title.length <= 20));
});

test("menu: hi, menu, GET_STARTED, RESTART all show it; legacy payloads still work", () => {
  for (const e of [txt("hi"), txt("menu"), pb("GET_STARTED"), pb("RESTART"), txt("x", "MENU")]) {
    assert.deepEqual(payloads(step(G, e, ctx()).replies.at(-1)), ["BUY", "LIST", "ADMIN"], JSON.stringify(e));
  }
  // U7: the course list is a carousel (one card per course, "Đăng ký" = BUY:<slug>), not quick replies.
  const list = step(G, pb("MENU_COURSES"), ctx()).replies.at(-1);
  assert.deepEqual(list.attachment.payload.elements.map((e) => e.buttons.at(-1).payload), ["BUY:khoa_b", "BUY:khoa-a"]);
  assert.deepEqual(payloads(list), ["MENU", "ADMIN"]);
  assert.equal(step(G, pb("HUMAN"), ctx()).action.reason, "human");
  const old = settle(step(G, txt("Khóa A", "COURSE:khoa-a"), ctx()));
  assert.equal(old.state.course, "khoa-a", "COURSE:<slug> behaves like BUY:<slug>");
});

test("greeting text is exact and comes first in a conversation", () => {
  const want = "Chào bạn! 👋 Mình là trợ lý tự động của Yêu học bánh. Bạn muốn đăng ký khóa học hay cần hỗ trợ gì ạ?";
  const out = step(emptyState(), pb("GET_STARTED"), ctx());
  assert.equal(textOf(out.replies[0]), want);
  assert.equal(out.replies.length, 1);
  assert.equal(step(emptyState(), txt("menu"), ctx()).replies[0].text, want);
});

// ---- 3-4 Admin ----
test("Admin handover text is exact; ticket failure text kept", () => {
  assert.equal(TICKET_OK_TEXT, "Mình đã chuyển yêu cầu của bạn tới Admin. Admin sẽ hỗ trợ trực tiếp trong cuộc trò chuyện này.");
  const off = step(G, pb("HUMAN"), ctx({ ticketsEnabled: false }));
  assert.equal(off.replies[0].text, TICKET_OK_TEXT);
});

test("ADMIN: one message with 3 quick replies; back goes to the menu", () => {
  const out = step(G, pb("ADMIN"), ctx());
  assert.deepEqual(out.replies[0].quick_replies.map((q) => [q.title, q.payload]), [["Hỏi về khóa học khác", "ADMIN_COURSE"], ["Hỗ trợ vấn đề khác", "ADMIN_SUPPORT"], ["Quay lại menu", "MENU"]]);
  assert.deepEqual(payloads(step(out.state, txt("Quay lại menu", "MENU"), ctx()).replies[0]), ["BUY", "LIST", "ADMIN"]);
});

test("ADMIN branches: ask one question, next text opens the right ticket with the text as summary", () => {
  let out = step(G, pb("ADMIN_COURSE"), ctx());
  assert.equal(out.replies[0].text, "Bạn quan tâm khóa học nào?");
  assert.deepEqual(out.replies[0].quick_replies.map((q) => [q.title, q.payload]), [["Bỏ qua, gặp Admin", "ADMIN_SKIP"]]);
  assert.equal(out.state.pendingAdmin, "other_course");
  let t = step(out.state, txt("khóa làm bánh mì"), ctx());
  assert.deepEqual(t.action, { type: "openTicket", reason: "other_course", summary: "khóa làm bánh mì" });
  assert.equal(t.state.pendingAdmin, null);
  out = step(G, pb("ADMIN_SUPPORT"), ctx());
  assert.equal(out.replies[0].text, "Bạn mô tả ngắn vấn đề giúp mình nhé.");
  t = step(out.state, txt("Bỏ qua, gặp Admin", "ADMIN_SKIP"), ctx());
  assert.deepEqual(t.action, { type: "openTicket", reason: "support", summary: "" });
  assert.equal(step(G, txt("cho mình gặp admin"), ctx()).action.reason, "human");
});

// ---- 5 loadCourses ----
function coursesDb(rows) {
  const calls = [];
  const q = {
    select: () => q, in: (k, v) => { calls.push(v); q.slugs = v; return q; },
    eq: (k, v) => { q.eqs.push([k, v]); return q; },
    then: (res) => res({ data: rows.filter((r) => (!q.slugs || q.slugs.includes(r.slug)) && q.eqs.every(([k, v]) => (k.includes("->>") ? String(r.raw_data?.[k.split("->>")[1]]) === v : r[k] === v))), error: null })
  };
  return { from: () => { q.slugs = null; q.eqs = []; return q; }, calls };
}
const row = (slug, extra = {}, raw = {}) => ({ slug, title: slug.toUpperCase(), price: "1", active: true, delivery_mode: "lms", image_url: "https://i.example/x.png", raw_data: { messengerSale: true, bankAccount: "9", ...raw }, ...extra });

test("loadCourses: needs messengerSale, price, bank account, active, not paused, not Telegram", async () => {
  const rows = [row("ok"), row("off", {}, { messengerSale: false }), row("noprice", { price: "" }), row("nobank", {}, { bankAccount: "" }),
    row("inactive", { active: false }), row("paused", {}, { salePaused: true }), row("tg", { delivery_mode: "telegram" })];
  assert.deepEqual((await loadCourses({}, coursesDb(rows))).map((c) => c.slug), ["ok"]);
});

test("loadCourses: empty MESSENGER_COURSE_SLUGS does not filter; set value only narrows", async () => {
  const rows = [row("b"), row("a"), row("c")];
  const db = coursesDb(rows);
  assert.deepEqual((await loadCourses({}, db)).map((c) => c.slug), ["a", "b", "c"], "by title");
  assert.deepEqual((await loadCourses({ MESSENGER_COURSE_SLUGS: "c,a" }, db)).map((c) => c.slug), ["c", "a"], "env order");
});

test("loadCourses: featured first, only one featured, returns imageUrl", async () => {
  const rows = [row("a"), row("b", {}, { messengerFeatured: true }), row("c", {}, { messengerFeatured: true })];
  const list = await loadCourses({}, coursesDb(rows));
  assert.deepEqual(list.map((c) => [c.slug, c.featured]), [["b", true], ["c", false], ["a", false]]);
  assert.equal(list[0].imageUrl, "https://i.example/x.png");
});

// ---- 6-7 BUY / LIST ----
test("BUY without slug: ref course, else featured, else the list", () => {
  assert.equal(settle(step(G, pb("BUY"), ctx())).state.course, "khoa_b", "featured");
  assert.equal(settle(step({ ...G, ref: "c__khoa-a" }, pb("BUY"), ctx())).state.course, "khoa-a", "ref first");
  const none = step(G, pb("BUY"), ctx({ courses: [A] }));
  // U7: carousel, one card with "Đăng ký" (BUY:khoa-a).
  assert.deepEqual(none.replies.at(-1).attachment.payload.elements[0].buttons.at(-1), { type: "postback", title: "Đăng ký", payload: "BUY:khoa-a" });
});

test("BUY:<slug>: unknown slug says so and shows the list", () => {
  const out = step(G, pb("BUY:khoa-zzz"), ctx());
  assert.match(out.replies[0].text, /^Khóa này hiện chưa mở đăng ký\./);
  assert.ok(JSON.stringify(out.replies).includes("BUY:khoa-a"), "U7: the list is a carousel");
  assert.equal(out.state.course, null);
});

test("LIST (U7 carousel): 15 courses -> page 1 has 9 full-name cards + Xem tiếp + Admin; empty list keeps the Admin button", () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ ...A, slug: `c${i}`, title: "Một tên khóa học rất là dài dòng" }));
  const r = step(G, pb("LIST"), ctx({ courses: many })).replies.at(-1);
  assert.equal(r.attachment.payload.elements.length, 9);
  assert.equal(r.attachment.payload.elements[0].title, "Một tên khóa học rất là dài dòng", "the whole name, not cut to 20");
  assert.ok(r.quick_replies.every((q) => q.title.length <= 20));
  assert.deepEqual(payloads(r), ["MENU", "ADMIN", "LIST:2"]);
  const empty = step(G, pb("LIST"), ctx({ courses: [] })).replies[0];
  assert.equal(empty.text, "Hiện chưa có khóa nào mở đăng ký qua Messenger.");
  assert.deepEqual(payloads(empty), ["ADMIN", "MENU"]);
});

// ---- 8 short buy flow ----
test("short flow: card, Gmail ask with user_email, confirm text, payment only after GMAIL_OK", () => {
  let out = settle(step(G, pb("BUY:khoa-a"), ctx()));
  const card = out.replies[0].attachment.payload.elements[0];
  assert.equal(out.replies[0].attachment.payload.template_type, "generic");
  assert.deepEqual([card.title, card.subtitle, card.image_url], ["Khóa A", "Học phí: 100.000đ", "https://img.example/a.jpg"]);
  assert.deepEqual(card.buttons, [{ type: "postback", title: "Xem nội dung khóa", payload: "DETAIL:khoa-a" }, { type: "postback", title: "Đổi khóa học", payload: "CHANGE_COURSE" }]); // U9: label and payload
  assert.equal(out.replies[1].text, "Bạn gửi Gmail dùng để học (đăng nhập Google trên trang học) nhé.");
  // U2: the Gmail ask also carries "Hủy đăng ký" and "Chat với Admin".
  assert.deepEqual(out.replies[1].quick_replies[0], { content_type: "user_email" });
  assert.deepEqual(payloads({ quick_replies: out.replies[1].quick_replies.slice(1) }), ["CHANGE_COURSE", "CANCEL_DRAFT", "ADMIN"]);
  assert.ok(!JSON.stringify(out.replies).includes("0123"));
  out = step(out.state, txt("me@yahoo.com"), ctx());
  assert.match(out.replies[0].text, /không phải tài khoản Google/);
  assert.equal(out.replies[1].text, 'Đăng ký khóa "Khóa A" bằng Gmail me@yahoo.com. Đúng không?');
  assert.deepEqual(out.replies[1].quick_replies.map((q) => q.payload), ["GMAIL_OK", "GMAIL_NO", "CHANGE_COURSE", "CANCEL_DRAFT", "ADMIN"], "U2/U9 exits");
  // P0-1: GMAIL_OK is answered by the DO after an order check (checkPayment); the pure step only asks for it and sets nothing.
  out = step(out.state, txt("Đúng", "GMAIL_OK"), ctx());
  assert.deepEqual(out.action, { type: "checkPayment", slug: "khoa-a", gmail: "me@yahoo.com" });
  assert.equal(out.state.gmailOk, false);
  assert.deepEqual(out.replies, []);
});

test("toEvent: user_email quick reply (payload = e-mail) becomes typed text", () => {
  const e = toEvent({ message: { mid: "m", text: "a@gmail.com", quick_reply: { payload: "a@gmail.com" } } });
  assert.deepEqual(e, { kind: "text", text: "a@gmail.com" });
  const out = step({ ...G, course: "khoa-a" }, e, ctx());
  assert.equal(out.state.gmail, "a@gmail.com");
});

// ---- DO harness ----
function fakeStorage() {
  const map = new Map();
  return { map, async get(k) { return map.has(k) ? structuredClone(map.get(k)) : undefined; }, async put(k, v) { map.set(k, structuredClone(v)); } };
}
const msg = (mid, message) => ({ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, message: { mid, ...message } });
const IMG = "https://scontent.xx.fbcdn.net/v/bill.jpg";
const image = (mid) => msg(mid, { attachments: [{ type: "image", payload: { url: IMG } }] });
const quick = (mid, text, payload) => msg(mid, { text, quick_reply: { payload } });

function harness({ statuses = {}, courses = COURSES, tickets = true, active = null, extraDeps = {}, env = {} } = {}) {
  const sent = [];
  const orders = [];
  const opened = [];
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
    activeTicket: async () => active, openTicket: async (a) => { opened.push(a); return { ok: true }; }, touchTicket: async () => {},
    loadOrder: async (id) => statuses[id] ?? null,
    loadPendingOrders: async () => [],
    loadCourseOrders: async () => [],
    createBillOrder: async (input, opts) => { orders.push({ input, opts }); return { status: 200, body: { orderId: `o${orders.length}` } }; },
    ...extraDeps
  });
  return { convo, sent, orders, opened, storage };
}
const buyFull = async (convo, slug, gmail, base) => {
  await convo.handle(PSID, quick(`${base}1`, "x", `BUY:${slug}`));
  await convo.handle(PSID, msg(`${base}2`, { text: gmail }));
  await convo.handle(PSID, quick(`${base}3`, "Đúng", "GMAIL_OK"));
  await convo.handle(PSID, image(`${base}4`));
};

test("several orders: A pending + order B creates 2 orders with the right slug/Gmail, A untouched", async () => {
  const h = harness({ statuses: { o1: { status: "Chờ duyệt" } } });
  await buyFull(h.convo, "khoa-a", "a@gmail.com", "a");
  await buyFull(h.convo, "khoa_b", "b@gmail.com", "b");
  assert.deepEqual(h.orders.map((o) => [o.input.course, o.input.gmail]), [["khoa-a", "a@gmail.com"], ["khoa_b", "b@gmail.com"]]);
  const s = (await h.storage.get("s")).state;
  assert.deepEqual(s.orders, [{ id: "o1", slug: "khoa-a" }, { id: "o2", slug: "khoa_b" }]);
  assert.equal(s.orderId, "o2");
  assert.deepEqual([s.course, s.gmail, s.gmailOk], [null, null, false], "draft cleared");
  assert.equal(h.sent.at(-1).text, "Mình đã nhận bill. Đơn đang chờ Admin đối chiếu chuyển khoản. Khi được duyệt, mình sẽ nhắn bạn cách vào học.");
});

test("re-registering a course whose order is pending creates no order and no draft", async () => {
  const h = harness({ statuses: { o1: { status: "Chờ duyệt" } } });
  await buyFull(h.convo, "khoa-a", "a@gmail.com", "a");
  await h.convo.handle(PSID, quick("r1", "x", "BUY:khoa-a"));
  assert.equal(h.sent.at(-1).text, "Bạn đã có đơn khóa này đang chờ Admin xác nhận.");
  assert.equal((await h.storage.get("s")).state.course, null);
  await h.convo.handle(PSID, image("r2"));
  assert.equal(h.orders.length, 1);
});

test("re-registering an approved course shows the approved notice; a rejected/unknown order opens a new draft", async () => {
  const h = harness({ statuses: { o1: { status: "Đã duyệt", course_title: "Khóa A", customer_email: "a@gmail.com" } } });
  await buyFull(h.convo, "khoa-a", "a@gmail.com", "a");
  await h.convo.handle(PSID, quick("r1", "x", "BUY:khoa-a"));
  assert.match(h.sent.at(-1).text, /Đơn khoá "Khóa A" đã được duyệt/);
  h.convo.deps.loadOrder = async () => ({ status: "Từ chối" });
  await h.convo.handle(PSID, quick("r2", "x", "BUY:khoa-a"));
  assert.equal((await h.storage.get("s")).state.course, "khoa-a");
  assert.deepEqual(h.sent.at(-1).quick_replies[0], { content_type: "user_email" }, "U2: exits follow the e-mail button");
});

test("state with only orderId reads as one order; orders capped at 10 (oldest dropped)", () => {
  assert.deepEqual(ordersOf({ orderId: "x", course: "khoa-a" }), [{ id: "x", slug: "khoa-a" }]);
  const out = step({ ...G, orderId: "x", course: "khoa-a", gmail: "a@gmail.com", gmailOk: true }, txt("sao rồi shop"), ctx());
  assert.deepEqual(out.action, { type: "pendingOrders" }, "U6: tickets on reads the pending orders instead of listing every order");
  const off = step({ ...G, orderId: "x", course: "khoa-a", gmail: "a@gmail.com", gmailOk: true }, txt("sao rồi shop"), ctx({ ticketsEnabled: false }));
  assert.deepEqual(off.action, { type: "orderStatus", mode: "list", orders: [{ id: "x", slug: "khoa-a" }] }, "tickets off keeps the old list");
});

test("orders cap: the 11th order drops the first", async () => {
  const h = harness();
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, slug: `old${i}` }));
  await h.storage.put("s", { state: { ...emptyState(), greeted: true, orders: many }, mids: [], hits: [] });
  await buyFull(h.convo, "khoa-a", "a@gmail.com", "z");
  const s = (await h.storage.get("s")).state;
  assert.equal(s.orders.length, 10);
  assert.deepEqual(s.orders.at(-1), { id: "o1", slug: "khoa-a" });
  assert.equal(s.orders[0].id, "i1");
});

test("RESTART and 'Khóa khác' clear the draft and pendingAdmin but keep orders", () => {
  const st = { ...G, orders: [{ id: "o1", slug: "khoa-a" }], orderId: "o1", course: "khoa_b", gmail: "b@gmail.com", gmailOk: true, pendingAdmin: "support" };
  for (const e of [pb("RESTART"), txt("khóa khác")]) {
    const out = step(st, e, ctx());
    assert.deepEqual(out.state.orders, st.orders);
    assert.deepEqual([out.state.course, out.state.gmail, out.state.gmailOk, out.state.pendingAdmin], [null, null, false, null]);
  }
});

test("free text with orders and no draft (tickets on, U6): reads the pending orders only; tickets off still lists every order with its status", async () => {
  const h = harness({ statuses: { o1: { status: "Chờ duyệt" }, o2: { status: "Đã duyệt" } } });
  await buyFull(h.convo, "khoa-a", "a@gmail.com", "a");
  await buyFull(h.convo, "khoa_b", "b@gmail.com", "b");
  h.convo.deps.loadPendingOrders = async () => [{ id: "o1", slug: "khoa-a", title: "Khóa A", createdAt: "2026-11-09T10:00:00Z", psid: PSID, pageId: PAGE }];
  const before = h.sent.length;
  await h.convo.handle(PSID, msg("q1", { text: "sao rồi shop" }));
  assert.equal(h.sent.length, before + 1);
  assert.equal(h.sent.at(-1).text, "Đơn của tôi đang chờ duyệt\nKhóa A — gửi bill 09/11/2026");
  const off = harness({ tickets: false, statuses: { o1: { status: "Chờ duyệt" }, o2: { status: "Đã duyệt" } } });
  await buyFull(off.convo, "khoa-a", "a@gmail.com", "a");
  await buyFull(off.convo, "khoa_b", "b@gmail.com", "b");
  await off.convo.handle(PSID, msg("q1", { text: "sao rồi shop" }));
  const m = off.sent.at(-1);
  assert.match(textOf(m), /Khóa A: Chờ duyệt\nKhóa B: Đã duyệt - https:\/\/hoc\.yeubep\.shop\/my-courses\.html/);
  assert.deepEqual(payloads(m), ["BUY", "LIST", "ADMIN"]);
  off.convo.deps.loadOrder = async () => null;
  await off.convo.handle(PSID, msg("q2", { text: "sao nữa shop" }));
  assert.match(textOf(off.sent.at(-1)), /Khóa A: chưa được duyệt/);
});

test("image with an incomplete draft reminds the missing step; with no draft it shows order status", async () => {
  const h = harness({ statuses: { o1: { status: "Chờ duyệt" } } });
  await h.convo.handle(PSID, quick("a1", "x", "BUY:khoa-a"));
  await h.convo.handle(PSID, image("a2"));
  assert.equal(h.orders.length, 0);
  assert.equal(h.sent.at(-1).text, "Bạn gửi Gmail dùng để học (đăng nhập Google trên trang học) nhé.");
  await h.convo.handle(PSID, msg("a3", { text: "a@gmail.com" }));
  await h.convo.handle(PSID, quick("a4", "Đúng", "GMAIL_OK"));
  await h.convo.handle(PSID, image("a5"));
  await h.convo.handle(PSID, image("a6"));
  // U6: with tickets on a bill-less image reads the pending orders (here the fake DB answers none).
  assert.equal(h.sent.at(-1).text, "Bạn hiện không có đơn đăng ký nào đang chờ duyệt.");
});

test("duplicate mid creates no second order", async () => {
  const h = harness();
  await h.convo.handle(PSID, quick("d1", "x", "BUY:khoa-a"));
  await h.convo.handle(PSID, msg("d2", { text: "a@gmail.com" }));
  await h.convo.handle(PSID, quick("d3", "Đúng", "GMAIL_OK"));
  await h.convo.handle(PSID, image("d4"));
  await h.convo.handle(PSID, image("d4"));
  assert.equal(h.orders.length, 1);
});

test("a typed Gmail never changes whose order is looked up", async () => {
  const looked = [];
  const h = harness({ extraDeps: { loadPendingOrders: async (a) => { looked.push(a); return []; } } });
  await buyFull(h.convo, "khoa-a", "a@gmail.com", "a");
  await h.convo.handle(PSID, msg("t1", { text: "kiểm tra khac@gmail.com giúp" }));
  // U6: the lookup is keyed by PSID + Page ID only (was: the order ids of the conversation).
  assert.deepEqual(looked, [{ psid: PSID, pageId: PAGE }]);
});

// ---- 9/12 tickets silent ----
test("open ticket: bot silent for text, postback, referral and image; only touches the ticket", () => {
  const c = ctx({ activeTicket: { id: "t1" } });
  for (const e of [txt("hi"), pb("BUY"), { kind: "referral", ref: "c__khoa-a" }, { kind: "image", url: IMG }, { kind: "postback", payload: "GET_STARTED", ref: "c__khoa-a" }]) {
    const out = step(G, e, c);
    assert.deepEqual(out.replies, [], e.kind);
    assert.deepEqual(out.action, { type: "touchTicket" });
  }
});

test("DO: open ticket means no Send API call for referral either", async () => {
  const h = harness({ active: { id: "t1" } });
  await h.convo.handle(PSID, { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 5, referral: { ref: "c__khoa-a" } });
  assert.equal(h.sent.length, 0);
});

// ---- 10 SLA gone ----
test("no promise of a time: approveSla / 24 giờ are gone from code and config", () => {
  for (const f of ["utils/messenger/bot.js", "cloudflare/commerce-worker/src/messenger.js", "cloudflare/commerce-worker/wrangler.toml", "cloudflare/commerce-worker/wrangler.production.toml", "cloudflare/commerce-worker/wrangler.staging.toml.example"]) {
    assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), /approveSla|APPROVE_SLA|24 giờ|thường trong|trong vòng/, f);
  }
  assert.equal(orderCreatedReply().text, "Mình đã nhận bill. Đơn đang chờ Admin đối chiếu chuyển khoản. Khi được duyệt, mình sẽ nhắn bạn cách vào học.");
});

// ---- 11 referral ----
test("toEvent: postback keeps kind+payload and adds ref; messaging_referrals gives kind referral", () => {
  assert.deepEqual(toEvent({ postback: { payload: "GET_STARTED", referral: { ref: "c__khoa-a" } } }), { kind: "postback", payload: "GET_STARTED", ref: "c__khoa-a" });
  assert.deepEqual(toEvent({ referral: { ref: "c__khoa-a__fb1" } }), { kind: "referral", ref: "c__khoa-a__fb1" });
  assert.equal(toEvent({ postback: { payload: "X" } }).ref, undefined);
  assert.notEqual(eventId({ timestamp: 1, referral: { ref: "c__a" } }), eventId({ timestamp: 1, referral: { ref: "c__b" } }));
});

test("referral: valid ref (with label, underscore slug) opens that course's flow and stores state.ref", () => {
  let out = settle(step(emptyState(), { kind: "referral", ref: "c__khoa-a__fb_ad-1" }, ctx()));
  assert.equal(out.state.course, "khoa-a");
  assert.equal(out.state.ref, "c__khoa-a__fb_ad-1");
  assert.ok(out.replies.some((r) => r.attachment), "card sent");
  out = settle(step(emptyState(), { kind: "postback", payload: "GET_STARTED", ref: "c__khoa_b" }, ctx()));
  assert.equal(out.state.course, "khoa_b");
});

test("referral: bad ref, disabled course or unknown label shape goes to the 3-button menu", () => {
  for (const ref of ["xyz", "c__", "c__khoa-zzz", "c__khoa-a__" + "x".repeat(41), "C__KHOA-A", "c__khoa-a extra"]) {
    const out = step(emptyState(), { kind: "referral", ref }, ctx());
    assert.equal(out.state.course, null, ref);
    assert.deepEqual(payloads(out.replies.at(-1)), ["BUY", "LIST", "ADMIN"], ref);
  }
});

test("order gets the ref in rawExtra only when there is one", async () => {
  const h = harness();
  await h.convo.handle(PSID, { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 9, referral: { ref: "c__khoa-a__fb1" } });
  await h.convo.handle(PSID, msg("r2", { text: "a@gmail.com" }));
  await h.convo.handle(PSID, quick("r3", "Đúng", "GMAIL_OK"));
  await h.convo.handle(PSID, image("r4"));
  assert.deepEqual(h.orders[0].opts.rawExtra, { channel: "facebook", psid: PSID, pageId: PAGE, ref: "c__khoa-a__fb1" });
  const h2 = harness();
  await buyFull(h2.convo, "khoa-a", "a@gmail.com", "n");
  assert.deepEqual(h2.orders[0].opts.rawExtra, { channel: "facebook", psid: PSID, pageId: PAGE });
});

// ---- 12 admin ticket reasons in DO ----
test("DO: pendingAdmin ticket carries the new reason and redacted summary; skip gives empty summary", async () => {
  const h = harness();
  await h.convo.handle(PSID, quick("p1", "Hỏi khác", "ADMIN_COURSE"));
  await h.convo.handle(PSID, msg("p2", { text: "khóa A, sdt 0912345678" }));
  assert.deepEqual([h.opened[0].reason, h.opened[0].summary], ["other_course", "khóa A, sdt [số]"]);
  assert.equal(h.sent.at(-1).text, TICKET_OK_TEXT);
  await h.convo.handle(PSID, quick("p3", "Hỗ trợ", "ADMIN_SUPPORT"));
  await h.convo.handle(PSID, quick("p4", "Bỏ qua, gặp Admin", "ADMIN_SKIP"));
  assert.deepEqual([h.opened[1].reason, h.opened[1].summary], ["support", ""]);
});

// ---- 13 offer ----
function offerSetup({ courses = COURSES, sendOk = true, env = {}, courseRows = [] } = {}) {
  const h = harness({ courses, env });
  let failUpdate = false;
  if (!sendOk) h.convo.deps.fetchImpl = async () => new Response("{}", { status: 400 });
  const rows = [{ id: UUID, page_id: PAGE, psid: PSID, status: "open" }];
  const db = {
    from: (table) => {
      const q = { op: "select", filters: [] };
      const src = table === "courses" ? courseRows : rows;
      const api = {
        select: () => api, order: () => api, update: (p) => { q.op = "update"; q.p = p; return api; },
        eq: (k, v) => { q.filters.push([k, v]); return api; }, in: (k, v) => { q.filters.push([k, v, true]); return api; },
        limit: () => api, maybeSingle: () => { q.maybe = true; return api; },
        then: (res, rej) => {
          const hit = src.filter((r) => q.filters.every(([k, v, i]) => (k.includes("->>") ? String(r.raw_data?.[k.split("->>")[1]]) === v : i ? v.includes(r[k]) : r[k] === v)));
          if (q.op === "update" && failUpdate) return rej(new Error("write failed"));
          if (q.op === "update") { hit.forEach((r) => Object.assign(r, q.p)); return res({ data: hit.map((r) => ({ id: r.id })), error: null }); }
          return res({ data: q.maybe ? hit[0] || null : hit, error: null });
        }
      };
      return api;
    }
  };
  const seen = [];
  const ns = { idFromName: (n) => n, get: () => ({ fetch: async (url, init) => { seen.push(new URL(url).pathname); return h.convo.fetch(new Request(url, init)); } }) };
  const call = async (body, method = "POST") => {
    process.env.MESSENGER_TICKETS_ENABLED = "1";
    process.env.ADMIN_PASSWORD = "pw";
    const res = await runCompatHandler(createHandler(db), new Request("https://yeubep.shop/api/messenger-tickets", {
      method, headers: { "content-type": "application/json", "x-admin-password": "pw" }, body: method === "GET" ? undefined : JSON.stringify(body)
    }), { __env: { MESSENGER_CONVERSATIONS: ns, MESSENGER_BOT_ENABLED: "1", ...env } });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { h, rows, call, seen, failUpdate: () => { failUpdate = true; } };
}

test("offer: sends card + Gmail ask, sets the ticket done, returns { ok, sent }", async () => {
  const o = offerSetup();
  const r = await o.call({ id: UUID, action: "offer", slug: "khoa-a" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.ok, r.json.sent], [true, true]);
  assert.deepEqual(o.seen, ["/offer"]);
  assert.ok(o.h.sent[0].attachment, "card");
  assert.deepEqual(o.h.sent[1].quick_replies.map((q) => q.payload ?? q.content_type), ["user_email", "CHANGE_COURSE", "CANCEL_DRAFT", "ADMIN"], "U2/U9 exits");
  assert.equal(o.rows[0].status, "done");
  assert.equal((await o.h.storage.get("s")).state.course, "khoa-a");
});

test("offer: unavailable course -> 409, ticket untouched, nothing sent; bad ids -> 400; unknown ticket -> 404", async () => {
  const o = offerSetup();
  const r = await o.call({ id: UUID, action: "offer", slug: "khoa-zzz" });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "course_unavailable");
  assert.equal(o.rows[0].status, "open");
  assert.equal(o.h.sent.length, 0);
  assert.equal((await o.call({ id: "nope", action: "offer", slug: "khoa-a" })).status, 400);
  assert.equal((await o.call({ id: UUID, action: "offer", slug: "Bad Slug!" })).status, 400);
  o.rows[0].status = "done";
  assert.equal((await o.call({ id: UUID, action: "offer", slug: "khoa-a" })).status, 404);
});

test("offer: Meta rejects the send -> ticket stays open", async () => {
  const o = offerSetup({ sendOk: false });
  const r = await o.call({ id: UUID, action: "offer", slug: "khoa-a" });
  assert.equal(r.status, 502);
  assert.equal(r.json.sent, false);
  assert.equal(o.rows[0].status, "open");
});

test("offer: needs the Admin password, like the rest of the endpoint", async () => {
  process.env.MESSENGER_TICKETS_ENABLED = "1";
  process.env.ADMIN_PASSWORD = "pw";
  const res = await runCompatHandler(createHandler({}), new Request("https://yeubep.shop/api/messenger-tickets", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: UUID, action: "offer", slug: "khoa-a" })
  }), { __env: {} });
  assert.equal(res.status, 401);
});

test("offer: course with a pending order -> says so, no new draft", async () => {
  const o = offerSetup();
  await buyFull(o.h.convo, "khoa-a", "a@gmail.com", "a");
  o.h.convo.deps.loadOrder = async () => ({ status: "Chờ duyệt" });
  const r = await o.call({ id: UUID, action: "offer", slug: "khoa-a" });
  assert.equal(r.status, 200);
  assert.equal(o.h.sent.at(-1).text, "Bạn đã có đơn khóa này đang chờ Admin xác nhận.");
});

test("GET tickets also returns the sellable courses (slug,title only)", async () => {
  const o = offerSetup();
  // loadCourses reads the same fake db (no courses rows there) -> picker empty, list still served
  const r = await o.call(undefined, "GET");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.courses));
});

test("DO routes by pathname: /event handles a webhook event, unknown path 404", async () => {
  const h = harness();
  const ok = await h.convo.fetch(new Request("https://messenger.internal/event", { method: "POST", body: JSON.stringify({ psid: PSID, ev: msg("e1", { text: "hi" }) }) }));
  assert.equal(ok.status, 200);
  assert.ok(h.sent.length > 0);
  assert.equal((await h.convo.fetch(new Request("https://messenger.internal/zzz", { method: "POST", body: "{}" }))).status, 404);
});

test("echo of the bot's own message (app_id) opens no ticket; a human echo does", async () => {
  const h = harness();
  const echo = (mid, app) => ({ sender: { id: PAGE }, recipient: { id: PSID }, timestamp: 1, message: { mid, is_echo: true, app_id: app, text: "x" } });
  await h.convo.handle(PSID, echo("e1", 777));
  assert.equal(h.opened.length, 0);
  await h.convo.handle(PSID, echo("e2", 1));
  assert.equal(h.opened[0].reason, "admin_reply");
});

test("opening a ticket accepts the two new reasons (DB helper passes them through)", async () => {
  const { openTicket } = await import("../utils/messenger/tickets.js");
  const rows = [];
  const db = { from: () => ({ insert: (r) => { rows.push(r); return { select: () => ({ single: async () => ({ data: { id: "i" }, error: null }) }) }; } }) };
  for (const reason of ["other_course", "support"]) assert.equal((await openTicket({ pageId: PAGE, psid: PSID, reason }, db)).ok, true);
  assert.deepEqual(rows.map((r) => r.reason), ["other_course", "support"]);
});

// ---- 13 UI, 14 Admin switches, 15 migration ----
test("orders.html: send-registration control uses textContent only, confirm(), new reason labels", () => {
  const html = readFileSync(new URL("../orders.html", import.meta.url), "utf8");
  assert.match(html, /other_course: "Hỏi khóa khác", support: "Hỗ trợ khác"/);
  assert.match(html, /Gửi đăng ký khóa/);
  assert.match(html, /confirm\("Gửi hướng dẫn đăng ký khóa/);
  assert.match(html, /action: "offer"/);
  const block = html.slice(html.indexOf("// Messenger support tickets."), html.indexOf("async function loadOrders()"));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(block));
});

test("api/courses.js: messengerSale / messengerFeatured must be boolean and are stored in raw_data; featured is exclusive", () => {
  const src = readFileSync(new URL("../api/courses.js", import.meta.url), "utf8");
  assert.match(src, /\['messengerSale', 'messengerFeatured'\]/);
  assert.match(src, /typeof body\[key\] !== 'boolean'/);
  assert.match(src, /rawDataPatch\[key\] = body\[key\]/);
  assert.match(src, /rawDataPatch\.messengerFeatured === true/);
  assert.match(src, /raw_data: \{ \.\.\.other\.raw_data, messengerFeatured: false \}/);
});

test("admin.html: two switches, copy rows for web link and campaign code, no m.me link", () => {
  const html = readFileSync(new URL("../admin.html", import.meta.url), "utf8");
  assert.match(html, /Bán qua Messenger/);
  assert.match(html, /Khóa nổi bật/);
  assert.match(html, /toggleMessengerFlag\('\$\{id\}', 'messengerSale'/);
  assert.match(html, /Link web: \$\{link\}/);
  assert.match(html, /Mã chiến dịch Messenger: c__\$\{escapeAttr\(slug\)\}/);
  assert.doesNotMatch(html, /m\.me\//);
  assert.match(html, /course\.messengerSale === true/);
});

test("migration: new reasons, drops and re-adds the named constraint, 'not applied' + rollback comment", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261108100000_messenger_ticket_reasons.sql", import.meta.url), "utf8");
  assert.match(sql, /File only, not applied here/);
  assert.match(sql, /drop constraint if exists messenger_support_tickets_reason_check/);
  assert.match(sql, /check \(reason in \('human','unclear','self_help','admin_reply','other_course','support'\)\)/);
  assert.match(sql, /Rollback/);
});


// ---- review fixes ----
test("rollback V2 -> old -> V2: orderId missing from orders is added, draft cleared, a bill creates nothing", async () => {
  const h = harness();
  const A1 = { id: "oA", slug: "khoa-a" };
  await h.storage.put("s", { state: { ...emptyState(), greeted: true, orders: [A1], orderId: "oC", course: "khoa_b", gmail: "c@gmail.com", gmailOk: true }, mids: [], hits: [] });
  const n = normalizeState({ orders: [A1], orderId: "oC", course: "khoa_b", gmailOk: true });
  assert.deepEqual(n.orders, [A1, { id: "oC", slug: "khoa_b" }]);
  assert.deepEqual([n.course, n.gmail, n.gmailOk], [null, null, false]);
  await h.convo.handle(PSID, image("x1"));
  assert.equal(h.orders.length, 0);
  const s = (await h.storage.get("s")).state;
  assert.deepEqual(s.orders.map((o) => o.id), ["oA", "oC"]);
});

test("order lookup error is not 'not found': busy message, no draft opened", async () => {
  const h = harness({ statuses: { o1: { status: "Chờ duyệt" } } });
  await buyFull(h.convo, "khoa-a", "a@gmail.com", "a");
  h.convo.deps.loadOrder = async () => { throw new Error("db down"); };
  await h.convo.handle(PSID, quick("b1", "x", "BUY:khoa-a"));
  assert.equal(textOf(h.sent.at(-1)), "Hệ thống đang bận, bạn thử lại sau ít phút nhé.");
  assert.deepEqual(payloads(h.sent.at(-1)), ["BUY", "LIST", "ADMIN"]);
  assert.equal((await h.storage.get("s")).state.course, null);
});

test("a stale pendingAdmin is dropped when the bill creates an order: next text opens no ticket", async () => {
  const h = harness();
  await h.convo.handle(PSID, quick("p0", "x", "BUY:khoa-a"));
  await h.convo.handle(PSID, msg("p1", { text: "a@gmail.com" }));
  await h.convo.handle(PSID, quick("p2", "Đúng", "GMAIL_OK"));
  await h.convo.handle(PSID, quick("p3", "Hỗ trợ", "ADMIN_SUPPORT"));
  await h.convo.handle(PSID, image("p4"));
  assert.equal(h.orders.length, 1);
  await h.convo.handle(PSID, msg("p5", { text: "cảm ơn shop" }));
  assert.equal(h.opened.length, 0);
});

test("offer: ticket status write fails after the send -> 200 { ok, sent, done: false }", async () => {
  const o = offerSetup();
  const real = o.rows;
  o.failUpdate();
  const r = await o.call({ id: UUID, action: "offer", slug: "khoa-a" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.ok, r.json.sent, r.json.done], [true, true, false]);
  assert.equal(real[0].status, "open");
  assert.match(readFileSync(new URL("../orders.html", import.meta.url), "utf8"), /Đã gửi cho khách nhưng chưa đóng được ticket, bấm Hoàn thành\./);
});

test("offer: bot off -> 503 bot_unavailable, nothing sent, ticket unchanged", async () => {
  const o = offerSetup({ env: { MESSENGER_BOT_ENABLED: "0" } });
  const r = await o.call({ id: UUID, action: "offer", slug: "khoa-a" });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "bot_unavailable");
  assert.equal(o.h.sent.length, 0);
  assert.equal(o.rows[0].status, "open");
});

test("ref: only attached when it names the ordered course; cleared after the order and on RESTART; empty label invalid", async () => {
  const h = harness();
  await h.convo.handle(PSID, { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 9, referral: { ref: "c__khoa-a" } });
  await h.convo.handle(PSID, quick("f1", "x", "SWITCH:khoa_b")); // U9.3: BUY:khoa_b would ask first, the draft of khoa-a is open
  await h.convo.handle(PSID, msg("f2", { text: "b@gmail.com" }));
  await h.convo.handle(PSID, quick("f3", "Đúng", "GMAIL_OK"));
  await h.convo.handle(PSID, image("f4"));
  assert.deepEqual(h.orders[0].opts.rawExtra, { channel: "facebook", psid: PSID, pageId: PAGE }, "ref of another course is not attached");
  assert.equal((await h.storage.get("s")).state.ref, null, "cleared after the order");
  assert.equal(step({ ...G, ref: "c__khoa-a" }, pb("RESTART"), ctx()).state.ref, null);
  assert.equal(step({ ...G, ref: "c__khoa-a" }, pb("RESTART"), ctx({ ticketsEnabled: false })).state.ref, null);
  const bad = step(emptyState(), { kind: "referral", ref: "c__khoa-a__" }, ctx());
  assert.equal(bad.state.course, null);
  assert.deepEqual(payloads(bad.replies.at(-1)), ["BUY", "LIST", "ADMIN"]);
});

test("loadCourses asks the DB for active + messengerSale (JSON path filter)", async () => {
  const eqs = [];
  const q = { select: () => q, eq: (k, v) => { eqs.push([k, v]); return q; }, in: () => q, then: (res) => res({ data: [], error: null }) };
  await loadCourses({}, { from: () => q });
  assert.deepEqual(eqs, [["active", true], ["raw_data->>messengerSale", "true"]]);
});

test("GET tickets: courses carry only slug and title (no bank fields)", async () => {
  const o = offerSetup({ courseRows: [row("khoa-a"), row("khoa-off", {}, { messengerSale: false })] });
  const r = await o.call(undefined, "GET");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.courses, [{ slug: "khoa-a", title: "KHOA-A" }]);
  assert.ok(!/bank|price|9/.test(JSON.stringify(r.json.courses.map((c) => Object.keys(c)))));
});

// ---- api/courses.js behaviour (real handler, faked DB client) ----
async function coursesApi(method, body, dbRows) {
  process.env.SUPABASE_URL = "http://localhost:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  process.env.ADMIN_PASSWORD = "pw";
  process.env.LEGACY_HOST_ALLOWLIST = "yeubep.shop";
  const { default: handler } = await import("../api/courses.js");
  const { getServiceRoleClient } = await import("../server/supabase-service-role.js");
  const client = getServiceRoleClient();
  const original = client.from;
  const originalRpc = client.rpc;
  client.rpc = async () => ({ data: null, error: null });
  const updates = [];
  client.from = (table) => {
    // Host/tenant lookups: no tenant found, so the explicit Legacy host allowlist decides.
    if (table !== "courses") { const none = new Proxy({}, { get: (t, k) => (k === "then" ? (res) => res({ data: null, error: null }) : () => none) }); return none; }
    const q = { op: "select", f: [] };
    const api = {
      select: () => api, update: (p) => { q.op = "update"; q.p = p; return api; },
      eq: (k, v) => { q.f.push(["eq", k, v]); return api; }, neq: (k, v) => { q.f.push(["neq", k, v]); return api; },
      single: () => { q.single = true; return api; }, maybeSingle: () => { q.single = true; return api; },
      then: (res, rej) => {
        const hit = dbRows.filter((r) => q.f.every(([t, k, v]) => (t === "eq" ? r[k] === v : r[k] !== v)));
        if (q.op === "update") { hit.forEach((r) => { updates.push({ id: r.id, patch: q.p }); Object.assign(r, q.p); }); return Promise.resolve({ data: q.single ? hit[0] : hit, error: null }).then(res, rej); }
        return Promise.resolve({ data: q.single ? hit[0] || null : hit, error: null }).then(res, rej);
      }
    };
    return api;
  };
  try {
    const out = { statusCode: 200, headers: {}, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(d) { this.body = d; return this; }, end() { return this; } };
    await handler({ method, headers: { host: "yeubep.shop", "x-admin-password": "pw" }, query: {}, body }, out);
    return { res: out, updates };
  } finally {
    client.from = original;
    client.rpc = originalRpc;
  }
}
const baseBody = { id: "c1", slug: "khoa-a", courseName: "Khóa A", price: "1", deliveryMode: "lms" };

test("api/courses PUT: non-boolean messengerSale / messengerFeatured -> 400", async () => {
  for (const key of ["messengerSale", "messengerFeatured"]) {
    const { res, updates } = await coursesApi("PUT", { ...baseBody, [key]: "true" }, []);
    assert.equal(res.statusCode, 400, key);
    assert.equal(updates.length, 0);
  }
});

test("api/courses PUT: messengerFeatured true turns it off on other courses and keeps their other raw_data", async () => {
  const rows = [
    { id: "c1", slug: "khoa-a", title: "A", delivery_mode: "lms", active: true, is_published: false, raw_data: { bankAccount: "1" } },
    { id: "c2", slug: "khoa-b", title: "B", delivery_mode: "lms", active: true, raw_data: { messengerFeatured: true, messengerSale: true, bankAccount: "2", salePaused: false } },
    { id: "c3", slug: "khoa-c", title: "C", delivery_mode: "lms", active: true, raw_data: { messengerSale: true } }
  ];
  const { res, updates } = await coursesApi("PUT", { ...baseBody, messengerFeatured: true }, rows);
  assert.ok(res.statusCode < 400, JSON.stringify(res.body));
  const mine = updates.find((u) => u.id === "c1");
  assert.equal(mine.patch.raw_data.messengerFeatured, true);
  assert.equal(mine.patch.raw_data.bankAccount, "1", "own raw_data merged");
  const other = updates.find((u) => u.id === "c2");
  assert.deepEqual(other.patch, { raw_data: { messengerFeatured: false, messengerSale: true, bankAccount: "2", salePaused: false } });
  assert.ok(!updates.some((u) => u.id === "c3"), "courses that were not featured are not touched");
});
