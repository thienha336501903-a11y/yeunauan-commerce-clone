// Persistent Menu + Get Started body for POST /me/messenger_profile (Owner runs it, Meta gate 14/11). PM-1..4 keep it in step with the bot.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { step, emptyState, MENU3 } from "../utils/messenger/bot.js";
import { toEvent } from "../cloudflare/commerce-worker/src/messenger.js";

const body = JSON.parse(readFileSync(new URL("../cloudflare/commerce-worker/meta/persistent-menu.json", import.meta.url), "utf8"));
const A = { slug: "khoa-a", title: "Khóa A", price: "100.000đ", bankName: "VCB", bankAccount: "0123", bankOwner: "X", transferNote: "A", qrImageUrl: "", imageUrl: "" };
const ctx = (extra = {}) => ({ now: 1_000_000, courses: [A], ticketsEnabled: true, faq: [], activeTicket: null, commerceUrl: "https://shop.example", ...extra });
const tap = (payload) => toEvent({ postback: { title: "x", payload, mid: `pm-${payload}` } });

test("PM-1 only get_started + persistent_menu (no ice_breakers, so posting it leaves the Ice Breakers alone); one default locale; typing stays on", () => {
  assert.deepEqual(Object.keys(body).sort(), ["get_started", "persistent_menu"]);
  assert.equal(body.get_started.payload, "GET_STARTED");
  assert.equal(body.persistent_menu.length, 1);
  assert.equal(body.persistent_menu[0].locale, "default");
  assert.equal(body.persistent_menu[0].composer_input_disabled, false);
});

test("PM-2 the three items are the main menu (MENU3): same titles and payloads, postbacks, titles <= 30 characters", () => {
  const items = body.persistent_menu[0].call_to_actions;
  assert.deepEqual(items.map((i) => [i.title, i.payload]), MENU3);
  for (const i of items) {
    assert.equal(i.type, "postback");
    assert.ok([...i.title].length <= 30, i.title);
  }
});

test("PM-3 a returning customer (greeted, orders, no ticket) tapping a menu item gets the same step as the menu button; Get Started shows the greeting menu", () => {
  const st = { ...emptyState(), greeted: true, orders: [{ id: "o1", slug: "khoa-a" }] };
  for (const [, payload] of MENU3) {
    const out = step(st, tap(payload), ctx());
    assert.ok(out.replies.length || out.action, payload);
    assert.ok(!["createOrder"].includes(out.action?.type), payload);
    assert.deepEqual(out.state.orders, st.orders, payload);
  }
  const gs = step(st, tap("GET_STARTED"), ctx());
  assert.ok(gs.replies.length >= 1);
  assert.ok(!gs.action || gs.action.type !== "openTicket");
});

test("PM-4 while a ticket is open every menu tap and Get Started is silent: no reply, no menu, no order, no new ticket", () => {
  const st = { ...emptyState(), greeted: true, course: "khoa-a", gmail: "a@gmail.com", gmailOk: true };
  for (const payload of [...MENU3.map(([, p]) => p), "GET_STARTED"]) {
    const out = step(st, tap(payload), ctx({ activeTicket: { id: "t1", status: "in_progress" } }));
    assert.equal(out.replies.length, 0, payload);
    assert.equal(out.action?.type, "touchTicket", payload);
    assert.equal(out.state.course, "khoa-a", payload);
  }
});
