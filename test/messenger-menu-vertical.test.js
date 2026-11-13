// Main menu as a button template (vertical buttons on phones) instead of a quick-reply row (MV-1..5).
import test from "node:test";
import assert from "node:assert/strict";
import { step, emptyState, menuMessage, MENU3 } from "../utils/messenger/bot.js";
import { toEvent } from "../cloudflare/commerce-worker/src/messenger.js";

const A = { slug: "khoa-a", title: "Khóa A", price: "100.000đ", bankName: "VCB", bankAccount: "0123", bankOwner: "X", transferNote: "A", qrImageUrl: "", imageUrl: "" };
const ctx = (extra = {}) => ({ now: 1_000_000, courses: [A], ticketsEnabled: true, faq: [], activeTicket: null, commerceUrl: "https://shop.example", ...extra });
const G = { ...emptyState(), greeted: true };
const tpl = (m) => m.attachment?.payload;

test("MV-1 'menu' sends a button template: text, 3 postback buttons with the MENU3 titles/payloads, no quick replies", () => {
  const m = step(G, { kind: "text", text: "menu" }, ctx()).replies.at(-1);
  assert.equal(tpl(m).template_type, "button");
  assert.equal(tpl(m).text, "Bạn cần mình giúp gì?");
  assert.deepEqual(tpl(m).buttons, MENU3.map(([title, payload]) => ({ type: "postback", title, payload })));
  assert.equal(m.quick_replies, undefined);
});

test("MV-2 more than 3 options: first 3 are buttons, the rest stay quick replies in order", () => {
  const m = menuMessage("x", [["a", "A"], ["b", "B"], ["c", "C"], ["d", "D"], ["e", "E"]]);
  assert.deepEqual(tpl(m).buttons.map((b) => b.payload), ["A", "B", "C"]);
  assert.deepEqual(m.quick_replies, [{ content_type: "text", title: "d", payload: "D" }, { content_type: "text", title: "e", payload: "E" }]);
});

test("MV-3 Meta limits: template text cut to 640, titles of the real menus <= 20", () => {
  assert.equal(tpl(menuMessage("x".repeat(700), MENU3)).text.length, 640);
  const withDraft = step({ ...G, course: "khoa-a" }, { kind: "text", text: "menu" }, ctx()).replies.at(-1);
  for (const b of [...tpl(withDraft).buttons, ...(withDraft.quick_replies || [])]) assert.ok(b.title.length <= 20, b.title);
});

test("MV-4 a tapped template button (postback) gives the same answer as the old quick reply", () => {
  for (const [, payload] of MENU3) {
    const viaPostback = step(G, toEvent({ postback: { title: "x", payload, mid: "m1" } }), ctx());
    const viaQuick = step(G, toEvent({ message: { mid: "m2", text: "x", quick_replies: undefined, quick_reply: { payload } } }), ctx());
    assert.deepEqual(viaPostback.replies, viaQuick.replies, payload);
    assert.deepEqual(viaPostback.action, viaQuick.action, payload);
  }
});

test("MV-4b same equivalence with a draft, after a 12h gap (U8) and for the 4th+ options", () => {
  const draft = { ...G, course: "khoa-a", lastInboundAt: 1_000_000 };
  const states = [G, draft, { ...draft, lastInboundAt: 1_000_000 - 13 * 3600 * 1000 }];
  for (const st of states) for (const payload of ["BUY", "LIST", "ADMIN", "PENDING_ORDERS", "CONTINUE_DRAFT", "CANCEL_DRAFT", "MENU"]) {
    const a = step(st, toEvent({ postback: { title: "x", payload, mid: "m1" } }), ctx());
    const b = step(st, toEvent({ message: { mid: "m2", text: "x", quick_reply: { payload } } }), ctx());
    assert.deepEqual([a.state, a.replies, a.action], [b.state, b.replies, b.action], `${payload} ${JSON.stringify(st)}`);
  }
});

test("MV-6 intro longer than 640 (order summary): intro as plain text, then the button template", async () => {
  const { renderReplies } = await import("../utils/messenger/bot.js");
  const intro = "Khóa X: Đã duyệt - https://hoc.yeubep.shop/my-courses.html\n".repeat(15);
  const out = renderReplies([{ menu: { intro, ask: false } }], { pendingMenu: "hide" }, ctx());
  assert.equal(out.length, 2);
  assert.equal(out[0].text, intro);
  assert.equal(tpl(out[1]).text, "Bạn cần mình giúp gì?");
  assert.deepEqual(tpl(out[1]).buttons.map((b) => b.payload), MENU3.map(([, p]) => p));
});

test("MV-5 open ticket: a template button tap is silent too", () => {
  const out = step(G, toEvent({ postback: { title: "Đăng ký khóa học", payload: "BUY", mid: "m3" } }), ctx({ activeTicket: { id: "t1", status: "open" } }));
  assert.deepEqual(out.replies, []);
});
