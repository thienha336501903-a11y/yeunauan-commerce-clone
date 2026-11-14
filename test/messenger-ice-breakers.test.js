// Ice Breakers body for POST /me/messenger_profile (Owner runs it, Meta gate). IB-1..3 keep it in step with the bot.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { step, emptyState, MENU3 } from "../utils/messenger/bot.js";
import { toEvent } from "../cloudflare/commerce-worker/src/messenger.js";

const body = JSON.parse(readFileSync(new URL("../cloudflare/commerce-worker/meta/ice-breakers.json", import.meta.url), "utf8"));
const A = { slug: "khoa-a", title: "Khóa A", price: "100.000đ", bankName: "VCB", bankAccount: "0123", bankOwner: "X", transferNote: "A", qrImageUrl: "", imageUrl: "" };
const ctx = (extra = {}) => ({ now: 1_000_000, courses: [A], ticketsEnabled: true, faq: [], activeTicket: null, commerceUrl: "https://shop.example", ...extra });
const tap = (payload) => toEvent({ postback: { title: "x", payload, mid: `ib-${payload}` } });

test("IB-1 one default locale, at most 4 questions, same questions and payloads as the main menu (MENU3)", () => {
  assert.equal(body.ice_breakers.length, 1);
  assert.equal(body.ice_breakers[0].locale, "default");
  const items = body.ice_breakers[0].call_to_actions;
  assert.ok(items.length >= 1 && items.length <= 4);
  assert.deepEqual(items.map((i) => [i.question, i.payload]), MENU3);
});

test("IB-2 brand-new customer taps an Ice Breaker: greeting first, then the same step as the menu button; no ticket, no order", () => {
  for (const [, payload] of MENU3) {
    const out = step(emptyState(), tap(payload), ctx());
    assert.ok(out.state.greeted, payload);
    assert.match(out.replies[0].text, /trợ lý tự động/, payload);
    assert.ok(out.replies.length >= 2, payload);
    assert.ok(!["openTicket", "createOrder"].includes(out.action?.type), payload);
  }
});

test("IB-3 returning customer (draft, orders) tapping it keeps the draft and orders", () => {
  const st = { ...emptyState(), greeted: true, course: "khoa-a", gmail: "a@gmail.com", orders: [{ id: "o1", slug: "khoa-a" }] };
  for (const payload of ["LIST", "ADMIN"]) {
    const out = step(st, tap(payload), ctx());
    assert.equal(out.state.course, "khoa-a", payload);
    assert.deepEqual(out.state.orders, st.orders, payload);
  }
});
