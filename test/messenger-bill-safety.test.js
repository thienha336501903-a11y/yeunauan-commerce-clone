// Gate 1: only a real image at the bill step can create an order; every other attachment gets a truthful answer and creates nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { MessengerConversation, toEvent } from "../cloudflare/commerce-worker/src/messenger.js";
import { emptyState } from "../utils/messenger/bot.js";

const PSID = "1234567890123";
const PAGE = "555";
const NOW = Date.UTC(2026, 10, 11, 5);
const LIKE = 369239263222822;
const CDN = "https://scontent.xx.fbcdn.net/x";
const COURSE = { slug: "b", title: "Khoá B", price: "1", description: "", subtitle: "", bankName: "T", bankAccount: "0", bankOwner: "T", transferNote: "N" };
const att = (type, payload = { url: CDN }) => ({ type, payload });
const image = att("image");
const G = (extra = {}) => ({ ...emptyState(), greeted: true, lastInboundAt: NOW - 1000, ...extra });
const billStep = (extra = {}) => G({ course: "b", gmail: "a@gmail.com", gmailOk: true, ...extra });
const withOrder = () => G({ orders: [{ id: "o1", slug: "b" }] });
const PENDING = [{ id: "o1", slug: "b", title: "Khoá B", createdAt: "2026-11-11T00:00:00Z", psid: PSID, pageId: PAGE }];

function world({ state = billStep(), env = {}, deps = {}, ctype = "image/png" } = {}) {
  const store = new Map([["s", { state, mids: [], hits: [] }]]);
  const sent = [];
  const created = [];
  const tickets = [];
  let t = NOW;
  const fetchImpl = async (url, init) => {
    if (String(url).includes("graph.facebook.com")) { sent.push(JSON.parse(init.body).message); return new Response("{}", { status: 200 }); }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": ctype } });
  };
  const c = new MessengerConversation({ storage: { async get(k) { return structuredClone(store.get(k)); }, async put(k, v) { store.set(k, structuredClone(v)); } } },
    { META_PAGE_ACCESS_TOKEN: "t", META_APP_ID: "777", META_PAGE_ID: PAGE, MESSENGER_BOT_ENABLED: "1", MESSENGER_TICKETS_ENABLED: "1", ...env },
    { fetchImpl, now: () => (t += 1000), loadCourses: async () => [COURSE], loadFaq: () => [], activeTicket: async () => null, touchTicket: async () => {},
      openTicket: async (a) => { tickets.push(a); return { ok: true }; }, loadCourseOrders: async () => [], loadPendingOrders: async () => [],
      createBillOrder: async (x) => { created.push(x); return { status: 200, body: { orderId: `new${created.length}` } }; }, ...deps });
  return { c, store, sent, created, tickets, state: () => store.get("s").state };
}
let n = 0;
const send = (w, message) => w.c.handle(PSID, { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: ++n, message: { mid: `b${n}`, ...message } });
const texts = (w) => w.sent.map((m) => m.text || "").join(" | ");

test("BILL-1 every sticker format is a sticker, never an image", () => {
  const url = { url: CDN, sticker_id: LIKE };
  assert.deepEqual(toEvent({ message: { sticker_id: LIKE, attachments: [att("image", url)] } }), { kind: "sticker" });
  assert.deepEqual(toEvent({ message: { attachments: [att("image", url)] } }), { kind: "sticker" });
  assert.deepEqual(toEvent({ message: { attachments: [att("sticker", { sticker_id: LIKE })] } }), { kind: "sticker" });
  assert.deepEqual(toEvent({ message: { attachments: [att("sticker", { sticker_id: LIKE }), att("image", url)] } }), { kind: "sticker" });
});

test("BILL-2 other attachments are 'unsupported'; images, text and quick replies are unchanged", () => {
  for (const type of ["audio", "video", "file", "location", "fallback", "template"]) assert.deepEqual(toEvent({ message: { attachments: [att(type)] } }), { kind: "unsupported", type });
  assert.equal(toEvent({ message: { is_unsupported: true } }).kind, "unsupported");
  assert.deepEqual(toEvent({ message: { attachments: [image] } }), { kind: "image", url: CDN });
  assert.deepEqual(toEvent({ message: { attachments: [image, image] } }), { kind: "image", url: CDN, imageCount: 2 });
  assert.deepEqual(toEvent({ message: { text: "xem link", attachments: [att("fallback")] } }), { kind: "text", text: "xem link" });
  assert.deepEqual(toEvent({ message: { text: "Có", quick_reply: { payload: "MENU" }, attachments: [att("sticker")] } }), { kind: "text", text: "Có", payload: "MENU" });
  assert.equal(toEvent({ message: { mid: "x" } }), null);
  assert.equal(toEvent({ delivery: {} }), null);
});

for (const [name, a] of [["old sticker", att("image", { url: CDN, sticker_id: LIKE })], ["new sticker", att("sticker", { sticker_id: LIKE })]]) {
  test(`BILL-3 ${name} at the bill step: no order, draft kept, asks for the bill`, async () => {
    const w = world();
    await send(w, { attachments: [a] });
    assert.equal(w.created.length, 0);
    assert.equal(w.state().course, "b");
    assert.match(texts(w), /gửi ảnh chụp bill/);
    assert.ok(!/đã nhận bill/.test(texts(w)));
  });
}

test("BILL-4 sticker with no draft: silent, nothing created", async () => {
  for (const state of [G(), withOrder()]) {
    const w = world({ state });
    await send(w, { attachments: [att("sticker", { sticker_id: LIKE })] });
    assert.equal(w.sent.length, 0);
    assert.equal(w.created.length + w.tickets.length, 0);
  }
});

test("BILL-5 sticker while the Gmail step is open repeats that step", async () => {
  const w = world({ state: G({ course: "b" }) });
  await send(w, { attachments: [att("sticker", { sticker_id: LIKE })] });
  assert.match(texts(w), /Gmail/i);
  assert.equal(w.state().course, "b");
});

test("BILL-6 PDF, video, voice at the bill step: says it cannot read it, no order, draft kept", async () => {
  for (const type of ["file", "video", "audio"]) {
    const w = world();
    await send(w, { attachments: [att(type)] });
    assert.equal(w.created.length, 0, type);
    assert.equal(w.state().gmailOk, true, type);
    assert.match(texts(w), /chưa đọc được loại tin này.*JPG, PNG hoặc WEBP/, type);
  }
});

test("BILL-7 voice with no draft answers with the menu; open ticket stays silent; pendingAdmin survives", async () => {
  const none = world({ state: G() });
  await send(none, { attachments: [att("audio")] });
  assert.equal(none.sent.length, 1);
  assert.match(none.sent[0].text, /chưa đọc được loại tin này/);

  const ticket = world({ deps: { activeTicket: async () => ({ id: "t" }) } });
  await send(ticket, { attachments: [att("audio")] });
  assert.equal(ticket.sent.length, 0);

  const wait = world({ state: G({ pendingAdmin: "support" }) });
  await send(wait, { attachments: [att("sticker", { sticker_id: LIKE })] });
  assert.equal(wait.state().pendingAdmin, "support");
  assert.equal(wait.tickets.length, 0);
});

test("BILL-8 a real image at the bill step still creates exactly one order", async () => {
  const w = world();
  await send(w, { attachments: [image] });
  assert.equal(w.created.length, 1);
  assert.match(texts(w), /đã nhận bill/);
  assert.equal(w.state().course, null);
  assert.equal(w.tickets.length, 0);
});

for (const [status, code] of [[409, "sale_paused"], [404, undefined]]) {
  test(`BILL-9 course refuses the order (${status}): a ticket, no order, no image complaint, draft kept`, async () => {
    const w = world({ deps: { createBillOrder: async () => ({ status, body: { code } }) } });
    await send(w, { attachments: [image] });
    assert.equal(w.created.length, 0);
    assert.equal(w.tickets.length, 1);
    assert.equal(w.tickets[0].reason, "support");
    assert.match(w.tickets[0].summary, /không nhận đăng ký/);
    assert.ok(!w.tickets[0].summary.includes(PSID));
    assert.match(texts(w), /chưa nhận đăng ký.*chuyển Admin.*chưa cần chuyển khoản thêm/);
    assert.ok(!/JPG/.test(texts(w)));
    assert.equal(w.state().course, "b");
    assert.equal(w.store.get("s").creatingAt, 0);
  });
}

test("BILL-10 refused and the ticket cannot be written: tells the customer to ask for a person", async () => {
  const w = world({ deps: { createBillOrder: async () => ({ status: 409, body: {} }), openTicket: async () => { throw new Error("db"); } } });
  await send(w, { attachments: [image] });
  assert.match(texts(w), /nhắn "gặp người"/);
  assert.ok(!/đã chuyển Admin/.test(texts(w)));
});

test("BILL-11 tickets off, refused: no ticket call, honest answer", async () => {
  const w = world({ env: { MESSENGER_TICKETS_ENABLED: "0" }, deps: { createBillOrder: async () => ({ status: 409, body: {} }) } });
  await send(w, { attachments: [image] });
  assert.equal(w.tickets.length, 0);
  assert.match(texts(w), /nhắn "gặp người"/);
});

test("BILL-12 server error or a throw: no image complaint, lock released, retry works", async () => {
  let calls = 0;
  const createBillOrder = async () => { if (++calls === 1) return { status: 500, body: {} }; if (calls === 2) throw new Error("boom"); return { status: 200, body: { orderId: "n" } }; };
  const w = world({ deps: { createBillOrder } });
  await send(w, { attachments: [image] });
  assert.match(texts(w), /chưa tạo được đơn/);
  assert.ok(!/JPG/.test(texts(w)));
  assert.equal(w.store.get("s").creatingAt, 0);
  await send(w, { attachments: [image] });
  assert.equal(w.store.get("s").creatingAt, 0, "released after a throw");
  await send(w, { attachments: [image] });
  assert.match(w.sent.at(-1).text, /đã nhận bill/);
  assert.equal(w.tickets.length, 0);
});

test("BILL-13 image problems keep the image message (400, 413, GIF)", async () => {
  for (const status of [400, 413]) {
    const w = world({ deps: { createBillOrder: async () => ({ status, body: {} }) } });
    await send(w, { attachments: [image] });
    assert.match(texts(w), /JPG\/PNG\/WEBP/, String(status));
    assert.equal(w.tickets.length, 0);
  }
  const gif = world({ ctype: "image/gif" });
  await send(gif, { attachments: [image] });
  assert.match(texts(gif), /JPG\/PNG\/WEBP/);
  assert.equal(gif.created.length, 0);
});

test("BILL-14 image with a pending order: Admin ticket, no new order, order untouched", async () => {
  const w = world({ state: withOrder(), deps: { loadPendingOrders: async () => PENDING } });
  await send(w, { attachments: [image] });
  assert.equal(w.created.length, 0);
  assert.equal(w.tickets.length, 1);
  assert.equal(w.tickets[0].reason, "support");
  assert.match(w.tickets[0].summary, /gửi thêm ảnh/);
  assert.ok(!w.tickets[0].summary.includes(PSID));
  assert.match(texts(w), /nhận thêm ảnh/);
  assert.deepEqual(w.state().orders, [{ id: "o1", slug: "b" }]);
});

test("BILL-15 image with orders but none pending: no ticket; lookup error: busy, no ticket", async () => {
  const none = world({ state: withOrder() });
  await send(none, { attachments: [image] });
  assert.equal(none.tickets.length + none.created.length, 0);
  assert.ok(none.sent.length >= 1);
  const err = world({ state: withOrder(), deps: { loadPendingOrders: async () => { throw new Error("db"); } } });
  await send(err, { attachments: [image] });
  assert.equal(err.tickets.length, 0);
  assert.match(texts(err), /đang bận/);
});

test("BILL-16 ticket write fails for an extra image: says so honestly", async () => {
  const w = world({ state: withOrder(), deps: { loadPendingOrders: async () => PENDING, openTicket: async () => ({ ok: false }) } });
  await send(w, { attachments: [image] });
  assert.match(texts(w), /chưa ghi nhận được yêu cầu/);
  assert.ok(!/nhận thêm ảnh/.test(texts(w)));
});

test("BILL-17 two images in one message: one order from the first image, Admin told about the rest", async () => {
  const w = world();
  await send(w, { attachments: [image, att("image", { url: `${CDN}2` })] });
  assert.equal(w.created.length, 1);
  assert.equal(w.tickets.length, 1);
  assert.match(w.tickets[0].summary, /2 ảnh/);
  assert.match(texts(w), /đã nhận bill.*nhận thêm ảnh/);
});

test("BILL-18 two images with tickets off: one order, no ticket call", async () => {
  const w = world({ env: { MESSENGER_TICKETS_ENABLED: "0" } });
  await send(w, { attachments: [image, image] });
  assert.equal(w.created.length, 1);
  assert.equal(w.tickets.length, 0);
});

test("BILL-19 duplicate protection still holds: DB order at the bill step creates nothing; same mid twice is one order", async () => {
  const w = world({ deps: { loadCourseOrders: async () => [{ id: "x", psid: PSID, slug: "b", status: "Chờ duyệt", pageId: PAGE }] } });
  await send(w, { attachments: [image] });
  assert.equal(w.created.length, 0);
  assert.equal(w.tickets.length, 1);

  const same = world();
  const ev = { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, message: { mid: "dup", attachments: [image] } };
  await same.c.handle(PSID, ev);
  await same.c.handle(PSID, ev);
  assert.equal(same.created.length, 1);
});

test("BILL-20 two images: the ticket opens only after the order is saved and the lock is released; receipt has no pending button", async () => {
  let w;
  let seen;
  w = world({ deps: { openTicket: async () => { seen = structuredClone(w.store.get("s")); return { ok: true }; } } });
  await send(w, { attachments: [image, image] });
  assert.equal(seen.creatingAt, 0);
  assert.equal(seen.state.orders.length, 1);
  assert.equal(seen.state.course, null);
  assert.ok(!w.sent[0].quick_replies, "the bot goes silent, so no button that would not answer");
});

test("BILL-21 Meta CDN download failure is not reported as a bad image", async () => {
  const w = world();
  w.c.deps.fetchImpl = async (url, init) => {
    if (String(url).includes("graph.facebook.com")) { w.sent.push(JSON.parse(init.body).message); return new Response("{}", { status: 200 }); }
    return new Response("", { status: 503 });
  };
  await send(w, { attachments: [image] });
  assert.match(texts(w), /chưa tạo được đơn/);
  assert.ok(!/JPG/.test(texts(w)));
  assert.equal(w.created.length, 0);
  assert.equal(w.state().course, "b");
});

test("BILL-22 extra image with only an unverified order: Admin ticket, neutral text; open ticket or unknown ticket: no new ticket", async () => {
  const w = world({ state: withOrder(), deps: { loadPendingOrders: async () => [{ ...PENDING[0], id: "other", pageId: "" }] } });
  await send(w, { attachments: [image] });
  assert.equal(w.tickets.length, 1);
  assert.ok(!/đơn đang chờ/.test(texts(w)));
  const open = world({ state: withOrder(), deps: { activeTicket: async () => ({ id: "t" }), loadPendingOrders: async () => PENDING } });
  await send(open, { attachments: [image] });
  assert.equal(open.tickets.length + open.sent.length, 0);
  const unknown = world({ state: withOrder(), deps: { activeTicket: async () => { throw new Error("db"); }, loadPendingOrders: async () => PENDING } });
  await send(unknown, { attachments: [image] });
  assert.equal(unknown.tickets.length + unknown.created.length, 0);
});

test("BILL-23 tickets off: voice gets the course list, sticker with a bill step asks for the bill; after a long gap a draft gets the U8 question", async () => {
  const off = world({ state: G(), env: { MESSENGER_TICKETS_ENABLED: "0" } });
  await send(off, { attachments: [att("audio")] });
  assert.match(texts(off), /chưa đọc được loại tin này/);
  const offBill = world({ env: { MESSENGER_TICKETS_ENABLED: "0" } });
  await send(offBill, { attachments: [att("sticker", { sticker_id: LIKE })] });
  assert.equal(offBill.created.length, 0);
  assert.match(texts(offBill), /gửi ảnh chụp bill/);
  const back = world({ state: billStep({ lastInboundAt: NOW - 13 * 3600 * 1000 }) });
  await send(back, { attachments: [att("sticker", { sticker_id: LIKE })] });
  assert.equal(back.created.length, 0);
  assert.equal(back.state().course, "b");
  assert.match(JSON.stringify(back.sent), /chưa hoàn tất/);
});

test("BILL-24 emoji-only text counts as a sticker; emoji with words, digits and punctuation stay text", () => {
  for (const text of ["😍", "😍😍 ", "👍🏻", "❤️", "👨‍👩‍👧", "🇻🇳"]) assert.deepEqual(toEvent({ message: { text } }), { kind: "sticker" }, text);
  for (const text of ["ok 😍", "😍 khoá bánh", "1", "12", "1️⃣", ":)", "...", " ", ""]) assert.equal(toEvent({ message: { text } }).kind, "text", JSON.stringify(text));
});

test("BILL-25 DO: emoji with no draft is silent, no AI, no order list; at the bill step it asks for the bill", async () => {
  let ai = 0;
  const w = world({ state: withOrder(), env: { MESSENGER_AI_ENABLED: "1", AI: { run: async () => ({}) } }, deps: { runAi: async () => { ai++; return null; }, loadPendingOrders: async () => PENDING } });
  await send(w, { text: "😍" });
  assert.equal(ai, 0);
  assert.equal(w.sent.length, 0);
  const bill = world();
  await send(bill, { text: "👍" });
  assert.equal(bill.created.length, 0);
  assert.match(texts(bill), /gửi ảnh chụp bill/);
});

test("BILL-26 DO: AI 'clarify' for a customer with orders shows the menu, not the list; AI failure keeps the list", async () => {
  const run = async (runAi) => {
    let looked = 0;
    const w = world({ state: withOrder(), env: { MESSENGER_AI_ENABLED: "1", AI: { run: async () => ({}) } }, deps: { runAi, loadPendingOrders: async () => { looked++; return PENDING; } } });
    await send(w, { text: "hmm chắc vậy" });
    return { w, looked };
  };
  const clarify = await run(async () => ({ route: "clarify", answer: null, course_slug: null, sources: [] }));
  assert.ok(!/đang chờ duyệt\n/.test(texts(clarify.w)));
  assert.ok(clarify.w.sent.length >= 1);
  const failed = await run(async () => null);
  assert.match(texts(failed.w), /gửi bill/);
});

test("BILL-27 text symbols and question marks are not emoji-only stickers", () => {
  for (const text of ["\u2753", "\u2754", "\u00A9", "\u2122", "\u2753\u2753"]) assert.equal(toEvent({ message: { text } }).kind, "text", text);
});

test("BILL-28 sticker while the Admin question is open repeats its way out; first contact gets the greeting", async () => {
  for (const state of [G({ pendingAdmin: "support" }), G({ pendingAdmin: "support", course: "b" })]) {
    const w = world({ state });
    await send(w, { text: "😍" });
    assert.equal(w.state().pendingAdmin, "support");
    assert.equal(w.tickets.length, 0);
    assert.deepEqual(w.sent[0].quick_replies.map((q) => q.payload), ["ADMIN_SKIP"]);
  }
  const first = world({ state: emptyState() });
  await send(first, { text: "👋" });
  assert.match(first.sent[0].text, /^Chào bạn/);
});
