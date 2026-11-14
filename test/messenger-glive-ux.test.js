// G-LIVE-ux (14/11/2026): 30-minute registration run, DO alarm handoff, admin silence, reset after "Hoàn thành", routing rules.
// IDs follow CLAUDE_GLIVE_UX_RULEBOOK_20261114.md Part E (TM, RC, AD, DN, E5). Everything is offline: fake storage with alarm, fake DB, fake Meta.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  step, stepRaw, emptyState, HANDOFF_TEXT, NO_ORDERS_TEXT, TICKET_OK_TEXT, paymentInfo, adminIntent
} from "../utils/messenger/bot.js";
import { MessengerConversation, regMs, loadMyOrders } from "../cloudflare/commerce-worker/src/messenger.js";

const PSID = "1234567890123";
const PAGE = "555";
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const CDN = "https://scontent.xx.fbcdn.net/x";
const mk = (slug, title, extra = {}) => ({ slug, title, price: "199.000đ", description: "Mô tả khóa", subtitle: "", bankName: "VCB", bankAccount: "0123456789", bankOwner: "NGUYEN A", transferNote: `HOC ${slug}`, ...extra });
const BANH_MI = mk("banh-mi", "Bánh mì Việt Nam", { featured: true });
const BANH_KEM = mk("banh-kem", "Bánh kem cơ bản");
const TWO = [BANH_MI, BANH_KEM];
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };
const defer = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
const textOf = (m) => m.text ?? m.attachment?.payload?.text ?? "";
const payloadsOf = (m) => [...(m.attachment?.payload?.buttons || []), ...(m.quick_replies || [])].map((q) => q.payload ?? q.content_type);

function world({ courses = TWO, env = {}, deps = {}, state } = {}) {
  let alarm = null;
  const store = new Map();
  if (state) store.set("s", { state: { ...emptyState(), greeted: true, ...state }, mids: [], hits: [] });
  const w = { sent: [], created: [], tickets: [], touched: [], db: [], clock: T0, ticket: null, courses, openFailures: 0, alarms: [] };
  const storage = {
    async get(k) { return structuredClone(store.get(k)); },
    async put(k, v) { store.set(k, structuredClone(v)); },
    async setAlarm(t) { alarm = t; w.alarms.push(t); },
    async getAlarm() { return alarm; },
    async deleteAlarm() { alarm = null; }
  };
  const fetchImpl = async (url, init) => {
    if (String(url).includes("graph.facebook.com")) { const b = JSON.parse(init.body); if (b.message) w.sent.push(b.message); return new Response('{"message_id":"m"}', { status: 200 }); }
    if (w.download) await w.download.p;
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
  };
  const row = (o) => ({ id: o.id, slug: o.slug, status: o.status || "Chờ duyệt", title: w.courses.find((c) => c.slug === o.slug)?.title || o.slug, email: o.gmail || "lan@gmail.com", createdAt: new Date(T0).toISOString(), psid: PSID, pageId: PAGE });
  w.c = new MessengerConversation({ storage }, { META_PAGE_ACCESS_TOKEN: "t", META_APP_ID: "777", META_PAGE_ID: PAGE, MESSENGER_BOT_ENABLED: "1", MESSENGER_TICKETS_ENABLED: "1", ...env }, {
    fetchImpl, now: () => (w.clock += 1), loadFaq: () => [],
    touchTicket: async (id) => { w.touched.push(id); },
    loadCourses: async () => w.courses,
    activeTicket: async () => w.ticket,
    openTicket: async (a) => {
      if (w.openFailures > 0) { w.openFailures--; return { ok: false }; }
      w.tickets.push({ reason: a.reason, summary: a.summary || "", status: a.status });
      w.ticket = { id: "t1", status: a.status || "open" };
      return { ok: true };
    },
    loadCourseOrders: async ({ slug }) => { if (w.dbDown) throw new Error("db"); return w.db.filter((o) => o.slug === slug).map(row); },
    loadPendingOrders: async () => { if (w.dbDown) throw new Error("db"); return w.db.filter((o) => (o.status || "Chờ duyệt") === "Chờ duyệt").map(row); },
    loadMyOrders: async () => { if (w.dbDown) throw new Error("db"); return w.db.map(row); },
    loadOrder: async (id) => { const o = w.db.find((x) => x.id === id); return o ? { status: o.status || "Chờ duyệt", course_slug: o.slug, course_title: o.slug, customer_email: o.gmail } : null; },
    createBillOrder: async (x) => { if (w.orderGate) await w.orderGate.p; if (w.orderStatus) return { status: w.orderStatus, body: {} }; const id = `o${w.db.length + 1}`; w.db.push({ id, slug: x.course, gmail: x.gmail }); w.created.push(id); return { status: 200, body: { orderId: id } }; },
    ...deps
  });
  w.raw = () => store.get("s");
  w.state = () => store.get("s").state;
  w.alarm = () => alarm;
  w.at = (ms) => { w.clock = ms; };
  w.fireAlarm = async (at) => { w.clock = at; if (alarm !== null && alarm <= at) { alarm = null; await w.c.alarm(); } };
  w.sentText = () => w.sent.map(textOf);
  return w;
}
let n = 0;
const ev = (message, mid) => ({ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: ++n, message: { mid: mid || `m${n}`, ...message } });
const txt = (w, text, mid) => w.c.handle(PSID, ev({ text }, mid));
const press = (w, payload) => w.c.handle(PSID, ev({ text: "x", quick_reply: { payload } }));
const img = (w, mid) => w.c.handle(PSID, ev({ attachments: [{ type: "image", payload: { url: CDN } }] }, mid));
const sticker = (w) => w.c.handle(PSID, ev({ sticker_id: 369239263222822, attachments: [{ type: "image", payload: { url: CDN, sticker_id: 369239263222822 } }] }));
const voice = (w) => w.c.handle(PSID, ev({ attachments: [{ type: "audio", payload: { url: CDN } }] }));
const referral = (w, ref) => w.c.handle(PSID, { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: ++n, referral: { ref } });
const adminEcho = (w) => w.c.handle(PSID, { sender: { id: PAGE }, recipient: { id: PSID }, timestamp: ++n, message: { mid: `e${n}`, is_echo: true, app_id: 999, text: "Admin gõ tay" } });
const botEcho = (w) => w.c.handle(PSID, { sender: { id: PAGE }, recipient: { id: PSID }, timestamp: ++n, message: { mid: `e${n}`, is_echo: true, app_id: 777, text: "bot" } });

// A run at the bill step (BUY -> Gmail -> Đúng); returns the reg.
async function toBill(w, gmail = "lan@gmail.com") {
  await press(w, "BUY");
  await txt(w, gmail);
  await press(w, "GMAIL_OK");
  return w.raw().reg;
}
const ASK = /Bạn chụp ảnh bill chuyển khoản/;
const GOT = /Mình đã nhận bill/;

// ======== E1 timer ========
test("TM-01 a run opens with BUY, a card's BUY:slug, a named buy sentence, a campaign ref and an Admin /offer: deadline = start + 30 min and the alarm is set", async () => {
  const opens = {
    "BUY": (w) => press(w, "BUY"),
    "BUY:slug": (w) => press(w, "BUY:banh-kem"),
    "typed buy with a course": (w) => txt(w, "tôi muốn đăng ký Bánh mì Việt Nam"),
    "campaign ref": (w) => referral(w, "c__banh-kem"),
    "Admin /offer": async (w) => { const r = await w.c.offer(PSID, "banh-kem"); assert.equal(r.status, 200); }
  };
  for (const [name, open] of Object.entries(opens)) {
    const w = world();
    await open(w);
    const { reg } = w.raw();
    assert.ok(reg, name);
    assert.equal(reg.deadline, reg.startedAt + 1_800_000, name);
    assert.equal(reg.status, "active", name);
    assert.equal(w.alarm(), reg.deadline, name);
    assert.equal(w.raw().psid, PSID, name);
  }
});

test("TM-02 viewing the list, a card's details, or asking a price opens no run and sets no alarm", async () => {
  const w = world();
  await press(w, "LIST");
  await press(w, "DETAIL:banh-mi");
  await txt(w, "học phí Bánh mì Việt Nam bao nhiêu");
  await txt(w, "học phí");
  assert.equal(w.raw().reg, undefined);
  assert.equal(w.alarm(), null);
});

test("TM-03 nothing inside a run moves the deadline or the alarm", async () => {
  const w = world();
  const reg = await toBill(w);
  const steps = [() => txt(w, "menu"), () => press(w, "CONTINUE_DRAFT"), () => sticker(w), () => txt(w, "e gửi"), () => press(w, "BUY:banh-mi"), () => txt(w, "lan@gmail.com"), () => press(w, "MENU"), () => txt(w, "hi")];
  for (const s of steps) { w.clock += 5000; await s(); assert.equal(w.raw().reg.deadline, reg.deadline); assert.equal(w.alarm(), reg.deadline); assert.equal(w.raw().reg.startedAt, reg.startedAt); }
  const g = world();
  await press(g, "BUY");
  const r2 = g.raw().reg;
  for (const s of [() => txt(g, "lan@gmail.com"), () => press(g, "GMAIL_NO"), () => txt(g, "lan@gmail.com"), () => press(g, "GMAIL_OK")]) { g.clock += 5000; await s(); assert.equal(g.raw().reg.deadline, r2.deadline); assert.equal(g.alarm(), r2.deadline); }
});

test("TM-04 switching course inside a run keeps the old deadline (D-Owner-3)", async () => {
  const w = world();
  await press(w, "BUY");
  const reg = w.raw().reg;
  w.clock += 10 * MIN;
  await press(w, "BUY:banh-kem");
  assert.equal(w.state().course, "banh-mi", "asks before replacing");
  await press(w, "SWITCH:banh-kem");
  assert.equal(w.state().course, "banh-kem");
  assert.equal(w.raw().reg.deadline, reg.deadline);
  assert.equal(w.alarm(), reg.deadline);
});

test("TM-05 Cancel then register again: the old run is closed (no alarm, no ticket), the new run has a new deadline (D-Owner-4)", async () => {
  const w = world();
  await press(w, "BUY");
  const first = w.raw().reg;
  w.clock += 10 * MIN;
  await press(w, "CANCEL_DRAFT");
  assert.equal(w.raw().reg, null);
  assert.equal(w.alarm(), null);
  await w.fireAlarm(first.deadline + 1);
  assert.equal(w.tickets.length, 0);
  await press(w, "BUY");
  assert.ok(w.raw().reg.deadline > first.deadline);
  assert.equal(w.alarm(), w.raw().reg.deadline);
  // "Bắt đầu lại" closes the run too
  await press(w, "RESTART");
  assert.equal(w.raw().reg, null);
  assert.equal(w.alarm(), null);
});

test("TM-06 order at minute 5 and minute 29: run done, alarm deleted, the 30:00 alarm opens no ticket", async () => {
  for (const minute of [5, 29]) {
    const w = world();
    const reg = await toBill(w);
    w.at(reg.startedAt + minute * MIN);
    await img(w);
    assert.equal(w.created.length, 1, `minute ${minute}`);
    assert.equal(w.raw().reg.status, "done");
    assert.equal(w.alarm(), null);
    assert.ok(w.sentText().some((t) => GOT.test(t)));
    await w.fireAlarm(reg.deadline);
    await w.c.alarm(); // even a late-running alarm does nothing
    assert.equal(w.tickets.length, 0);
  }
});

test("TM-07 customer silent until 30:00: the alarm opens one support ticket, T1 goes out once, the bot is silent afterwards", async () => {
  const w = world();
  const reg = await toBill(w);
  w.sent.length = 0;
  await w.fireAlarm(reg.deadline);
  assert.equal(w.tickets.length, 1);
  assert.equal(w.tickets[0].reason, "support");
  assert.match(w.tickets[0].summary, /chưa hoàn tất sau 30 phút/);
  assert.deepEqual(w.sentText(), [HANDOFF_TEXT]);
  assert.equal(w.raw().reg.status, "handed");
  assert.equal(w.alarm(), null);
  w.sent.length = 0;
  w.clock += 5 * MIN;
  await txt(w, "alo shop");
  await img(w);
  await press(w, "BUY");
  await sticker(w);
  assert.deepEqual(w.sent, []);
  assert.equal(w.created.length, 0);
  assert.equal(w.tickets.length, 1);
});

test("TM-08 a message at 30:00 sharp or 30:20 before the alarm ran: handed over at once, the message is not handled, a later alarm opens no second ticket", async () => {
  for (const late of [0, 20_000]) {
    const w = world();
    const reg = await toBill(w);
    w.sent.length = 0;
    w.at(reg.deadline + late);
    await txt(w, "e gửi bill nhé");
    assert.equal(w.tickets.length, 1, `late ${late}`);
    assert.deepEqual(w.sentText(), [HANDOFF_TEXT]);
    assert.equal(w.created.length, 0);
    await w.fireAlarm(reg.deadline + late + 1000);
    assert.equal(w.tickets.length, 1);
    assert.equal(w.sent.length, 1);
  }
});

test("TM-09 a message at 29:59.999 is handled as usual (no handoff)", async () => {
  const w = world();
  const reg = await toBill(w);
  w.sent.length = 0;
  w.at(reg.deadline - 30);
  await txt(w, "e gửi");
  assert.equal(w.tickets.length, 0);
  assert.ok(w.sentText().some((t) => ASK.test(t)));
  assert.equal(w.raw().reg.status, "active");
});

test("TM-10 MESSENGER_REG_TIMEOUT_MS: only a whole number in [60000, 1800000] counts", () => {
  assert.equal(regMs({}), 1_800_000);
  assert.equal(regMs({ MESSENGER_REG_TIMEOUT_MS: "180000" }), 180_000);
  assert.equal(regMs({ MESSENGER_REG_TIMEOUT_MS: "60000" }), 60_000);
  assert.equal(regMs({ MESSENGER_REG_TIMEOUT_MS: "1800000" }), 1_800_000);
  for (const bad of ["59999", "1800001", "abc", "", "1e5", "-1", "120000.5", "0"]) assert.equal(regMs({ MESSENGER_REG_TIMEOUT_MS: bad }), 1_800_000, bad);
});

test("TM-10b the override shortens the run in the DO", async () => {
  const w = world({ env: { MESSENGER_REG_TIMEOUT_MS: "180000" } });
  await press(w, "BUY");
  assert.equal(w.raw().reg.deadline, w.raw().reg.startedAt + 180_000);
});

test("TM-11 Production config: no MESSENGER_REG_TIMEOUT_MS, no MESSENGER_RESUME_GAP_MS (the staging file no longer has the resume gap either)", () => {
  const prod = readFileSync(new URL("../cloudflare/commerce-worker/wrangler.production.toml", import.meta.url), "utf8");
  assert.doesNotMatch(prod, /MESSENGER_REG_TIMEOUT_MS/);
  assert.doesNotMatch(prod, /MESSENGER_RESUME_GAP_MS/);
  // wrangler.staging.toml is gitignored (not on a clean CI checkout); the tracked file is the .example.
  const stg = readFileSync(new URL("../cloudflare/commerce-worker/wrangler.staging.toml.example", import.meta.url), "utf8");
  assert.doesNotMatch(stg, /MESSENGER_RESUME_GAP_MS/);
  assert.doesNotMatch(stg, /^MESSENGER_REG_TIMEOUT_MS/m);
});

// ======== E2 race ========
test("RC-01 / RC-06 image at 29:58 with the order finished at 30:09: the 30:00 alarm waits, 1 order, 0 tickets, alarm deleted", async () => {
  const w = world();
  const reg = await toBill(w);
  w.orderGate = defer();
  w.at(reg.deadline - 2000);
  const a = img(w);
  await settle();
  assert.equal(w.raw().reg.status, "creating");
  await w.fireAlarm(reg.deadline);
  assert.equal(w.tickets.length, 0, "the alarm did not cut in");
  assert.ok(w.alarm() > reg.deadline, "the alarm was moved to the lock's end");
  w.at(reg.deadline + 9000);
  w.orderGate.resolve();
  await a;
  assert.equal(w.created.length, 1);
  assert.equal(w.tickets.length, 0);
  assert.equal(w.raw().reg.status, "done");
  assert.equal(w.alarm(), null);
  assert.ok(w.sentText().some((t) => GOT.test(t)));
});

test("RC-02 image at 29:58 and the order takes longer than 15 s: one ticket, no 'send again' text, run handed", async () => {
  const w = world({ deps: { billMs: 30 } });
  const reg = await toBill(w);
  w.orderGate = defer();
  w.at(reg.deadline - 2000);
  await img(w);
  assert.equal(w.tickets.length, 1);
  assert.match(w.tickets[0].summary, /^Tạo đơn quá thời gian/);
  assert.ok(w.sentText().some((t) => /chưa cần chuyển khoản lại/.test(t)));
  assert.ok(!w.sentText().some((t) => /gửi lại|thử gửi lại/.test(t)));
  assert.equal(w.raw().reg.status, "handed");
  assert.equal(w.alarm(), null);
  w.orderGate.resolve();
  await settle(20);
});

test("RC-03 image at 29:58, the order fails with a system error at 30:05: handoff ticket, T1, no 'try again in a few minutes'", async () => {
  const w = world();
  const reg = await toBill(w);
  w.orderGate = defer();
  w.orderStatus = 500;
  w.at(reg.deadline - 2000);
  const a = img(w);
  await settle();
  w.at(reg.deadline + 5000);
  w.orderGate.resolve();
  await a;
  assert.equal(w.created.length, 0);
  assert.equal(w.tickets.length, 1);
  assert.ok(w.sentText().includes(HANDOFF_TEXT));
  assert.ok(!w.sentText().some((t) => /sau ít phút/.test(t)));
  assert.equal(w.raw().reg.status, "handed");
});

test("RC-03b the same failure inside the deadline still asks the customer to retry, and the run stays open", async () => {
  const w = world();
  const reg = await toBill(w);
  w.orderStatus = 500;
  w.at(reg.startedAt + 5 * MIN);
  await img(w);
  assert.ok(w.sentText().some((t) => /sau ít phút/.test(t)));
  assert.equal(w.tickets.length, 0);
  assert.equal(w.raw().reg.status, "active");
  assert.equal(w.alarm(), reg.deadline);
  assert.equal(w.raw().creating, null);
});

test("RC-04 the Worker died while creating (no result): the alarm after the 180 s lock opens a 'result unknown' ticket", async () => {
  const w = world();
  const reg = await toBill(w);
  const rec = w.raw();
  rec.reg = { ...rec.reg, status: "creating" };
  rec.creating = { at: reg.deadline - 2000, mid: "dead" };
  await w.c.storage.put("s", rec);
  await w.c.storage.setAlarm(reg.deadline);
  await w.fireAlarm(reg.deadline);
  assert.equal(w.tickets.length, 0, "still inside the 180 s lock");
  assert.equal(w.alarm(), reg.deadline - 2000 + 180_000);
  await w.fireAlarm(reg.deadline - 2000 + 180_000);
  assert.equal(w.tickets.length, 1);
  assert.match(w.tickets[0].summary, /không rõ kết quả/);
  assert.equal(w.raw().reg.status, "handed");
});

test("RC-05 the handoff was written first: an image right after is silent, no order", async () => {
  const w = world();
  const reg = await toBill(w);
  const rec = w.raw();
  rec.reg = { ...rec.reg, status: "handing" };
  rec.handoff = { at: w.clock, state: "pending", tries: 1 };
  await w.c.storage.put("s", rec);
  w.sent.length = 0;
  await img(w);
  assert.deepEqual(w.sent, []);
  assert.equal(w.created.length, 0);
  assert.equal(w.raw().reg.deadline, reg.deadline);
});

test("RC-07 a second image 130 s later while the first is still being created: 'Mình đang xử lý bill…', still one order", async () => {
  const w = world();
  await toBill(w);
  w.orderGate = defer();
  const a = img(w);
  await settle();
  w.clock += 130_000;
  w.sent.length = 0;
  await img(w);
  assert.deepEqual(w.sentText(), ["Mình đang xử lý bill bạn vừa gửi, bạn chờ chút nhé."]);
  w.orderGate.resolve();
  await a;
  assert.equal(w.created.length, 1);
});

test("RC-08 the same webhook twice (one after the other, and at the same time): one order, one answer", async () => {
  const w = world();
  await toBill(w);
  w.sent.length = 0;
  await img(w, "same");
  await img(w, "same");
  assert.equal(w.created.length, 1);
  assert.equal(w.sentText().filter((t) => GOT.test(t)).length, 1);
  const g = world();
  await toBill(g);
  g.orderGate = defer();
  g.sent.length = 0;
  const a = img(g, "same2");
  await settle();
  const b = img(g, "same2");
  await settle();
  g.orderGate.resolve();
  await Promise.all([a, b]);
  assert.equal(g.created.length, 1);
  assert.equal(g.sent.length, 1);
});

test("RC-09 the alarm running twice opens one ticket", async () => {
  const w = world();
  const reg = await toBill(w);
  await w.fireAlarm(reg.deadline);
  await w.c.alarm();
  await w.c.alarm();
  assert.equal(w.tickets.length, 1);
  assert.equal(w.sent.filter((m) => m.text === HANDOFF_TEXT).length, 1);
});

test("RC-10 the handoff ticket fails to write 3 times then works: the bot is silent meanwhile, T1 goes out once, tries grow, no duplicate ticket", async () => {
  const w = world();
  const reg = await toBill(w);
  w.sent.length = 0;
  w.openFailures = 3;
  await w.fireAlarm(reg.deadline); // attempt 1 fails
  assert.equal(w.raw().handoff.state, "local");
  assert.equal(w.alarm(), w.clock + 60_000, "retry in a minute");
  w.clock += 1000;
  await txt(w, "alo"); // lazy retry (attempt 2) fails, message stays unanswered
  assert.deepEqual(w.sent, []);
  assert.equal(w.raw().handoff.state, "local");
  await w.fireAlarm(w.alarm()); // attempt 3 fails
  assert.deepEqual(w.sent, []);
  assert.equal(w.raw().handoff.state, "local");
  await w.fireAlarm(w.alarm()); // attempt 4 works
  assert.equal(w.tickets.length, 1);
  assert.deepEqual(w.sentText(), [HANDOFF_TEXT]);
  assert.equal(w.raw().handoff.state, "confirmed");
  assert.ok(w.raw().handoff.tries >= 4);
  assert.equal(w.raw().reg.status, "handed");
  assert.equal(w.alarm(), null);
});

test("RC-11 'gặp admin' / 'chuyển nhầm' while the bill is being created: the order is made first, then the ticket and its sentence", async () => {
  for (const said of ["gặp admin", "em chuyển nhầm tài khoản rồi"]) {
    const w = world();
    await toBill(w);
    w.orderGate = defer();
    const a = img(w);
    await settle();
    w.sent.length = 0;
    await txt(w, said);
    assert.deepEqual(w.sent, [], "held, not answered yet");
    assert.equal(w.tickets.length, 0);
    w.orderGate.resolve();
    await a;
    assert.equal(w.created.length, 1);
    assert.equal(w.tickets.length, 1);
    const texts = w.sentText();
    assert.ok(GOT.test(texts[0]));
    assert.equal(texts.at(-1), TICKET_OK_TEXT);
    assert.equal(w.raw().reg.status, "handed");
  }
});

// ======== E3 Admin holds the conversation ========
test("AD-01 an open ticket: text, a bill image at the bill step, sticker, voice, buttons and a campaign link all get silence; touchTicket runs, no order", async () => {
  const w = world();
  await toBill(w);
  w.ticket = { id: "tX", status: "open" };
  w.sent.length = 0;
  for (const send of [() => txt(w, "e gửi"), () => img(w), () => sticker(w), () => voice(w), () => press(w, "BUY"), () => press(w, "GMAIL_OK"), () => press(w, "ADMIN"), () => referral(w, "c__banh-kem")]) await send();
  assert.deepEqual(w.sent, []);
  assert.equal(w.created.length, 0);
  assert.equal(w.touched.length, 8);
});

test("AD-02 a ticket that existed before: BUY opens no run and gets silence", async () => {
  const w = world();
  w.ticket = { id: "tX", status: "in_progress" };
  await press(w, "BUY");
  assert.deepEqual(w.sent, []);
  assert.equal(w.raw().reg, undefined);
  assert.equal(w.alarm(), null);
});

test("AD-03 a handoff still being written: an image is silent, no order", async () => {
  const w = world();
  await toBill(w);
  const rec = w.raw();
  rec.handoff = { at: w.clock, state: "pending", tries: 1 };
  await w.c.storage.put("s", rec);
  w.sent.length = 0;
  await img(w);
  assert.deepEqual(w.sent, []);
  assert.equal(w.created.length, 0);
});

test("AD-04 an Admin typing from the inbox mid-run: admin_reply ticket in progress, run handed, alarm deleted", async () => {
  const w = world();
  await toBill(w);
  w.sent.length = 0;
  await adminEcho(w);
  assert.deepEqual(w.tickets.map((t) => [t.reason, t.status]), [["admin_reply", "in_progress"]]);
  assert.equal(w.raw().reg.status, "handed");
  assert.equal(w.alarm(), null);
  assert.deepEqual(w.sent, []);
});

test("AD-05 the bot's own echo (our app id) opens no ticket", async () => {
  const w = world();
  await toBill(w);
  await botEcho(w);
  assert.equal(w.tickets.length, 0);
  assert.equal(w.raw().reg.status, "active");
});

// ======== E4 Hoàn thành and the new run ========
async function handedByAlarm(extra = {}) {
  const w = world(extra);
  const reg = await toBill(w);
  await w.fireAlarm(reg.deadline);
  assert.equal(w.raw().handoff.state, "confirmed");
  return w;
}
const adminDone = (w) => { w.ticket = null; w.clock += 60_000; };

test("DN-01 ticket done, the customer says 'chào': the run is reset (draft, counters, reg, alarm), the menu shows, orders are kept", async () => {
  const w = world({ state: { orders: [{ id: "oOld", slug: "banh-kem" }], misses: 1 } });
  w.db.push({ id: "oOld", slug: "banh-kem", status: "Đã duyệt", gmail: "lan@gmail.com" });
  const reg = await toBill(w);
  await w.fireAlarm(reg.deadline);
  adminDone(w);
  w.sent.length = 0;
  await txt(w, "chào");
  const s = w.state();
  assert.equal(s.course, null);
  assert.equal(s.gmail, null);
  assert.equal(s.misses, 0);
  assert.deepEqual(s.orders, [{ id: "oOld", slug: "banh-kem" }]);
  assert.equal(w.raw().reg, null);
  assert.equal(w.raw().handoff, null);
  assert.equal(w.alarm(), null);
  assert.ok(w.sent.some((m) => /Bạn cần mình giúp gì/.test(textOf(m))));
});

test("DN-02 the ticket read began before the handoff was confirmed and says 'none': no reset, silent", async () => {
  const w = await handedByAlarm();
  const rec = w.raw();
  rec.handoff = { ...rec.handoff, confirmedAt: w.clock + 10_000 }; // confirmed "after" this message's ticket read began
  await w.c.storage.put("s", rec);
  w.ticket = null;
  w.sent.length = 0;
  await txt(w, "chào");
  assert.deepEqual(w.sent, []);
  assert.equal(w.raw().reg.status, "handed");
});

test("DN-03 after the reset, BUY for a course with a pending or approved order says so: no draft, no new order", async () => {
  for (const status of ["Chờ duyệt", "Đã duyệt"]) {
    const w = await handedByAlarm();
    w.db.push({ id: "oA", slug: "banh-mi", status, gmail: "lan@gmail.com" });
    adminDone(w);
    w.sent.length = 0;
    await press(w, "BUY:banh-mi");
    assert.equal(w.state().course, null, status);
    assert.ok(w.sentText().some((t) => /đã có đơn|đã được duyệt/.test(t)), status);
    assert.equal(w.created.length, 0);
  }
});

test("DN-04 after the reset, a bill image: T4 with no pending order, an 'extra image' ticket with one", async () => {
  const none = await handedByAlarm();
  adminDone(none);
  none.sent.length = 0;
  await img(none);
  assert.equal(none.created.length, 0);
  assert.match(none.sentText().at(-1), /chưa biết ảnh này thuộc đơn đăng ký nào/);
  assert.deepEqual(payloadsOf(none.sent.at(-1)), ["ADMIN", "MENU"]);
  const some = await handedByAlarm();
  some.db.push({ id: "oP", slug: "banh-mi", status: "Chờ duyệt", gmail: "lan@gmail.com" });
  some.state(); // state.orders is read from the DO: seed it through a first reset message
  adminDone(some);
  const rec = some.raw();
  rec.state.orders = [{ id: "oP", slug: "banh-mi" }];
  await some.c.storage.put("s", rec);
  some.tickets.length = 0;
  await img(some);
  assert.equal(some.created.length, 0);
  assert.equal(some.tickets.length, 1);
  assert.match(some.tickets[0].summary, /gửi thêm ảnh/);
});

test("DN-05 an old alarm running after the reset opens no ticket", async () => {
  const w = await handedByAlarm();
  adminDone(w);
  await txt(w, "chào");
  assert.equal(w.raw().reg, null);
  w.tickets.length = 0;
  w.clock += 40 * MIN;
  await w.c.alarm();
  assert.equal(w.tickets.length, 0);
});

test("DN-06 Admin /offer while a ticket was open: the handoff is cleared, a fresh 30-minute run opens, the next message does not reset the offered draft", async () => {
  const w = await handedByAlarm();
  adminDone(w); // the endpoint closes the ticket right after /offer
  w.clock += MIN;
  const r = await w.c.offer(PSID, "banh-kem");
  assert.equal(r.status, 200);
  const rec = w.raw();
  assert.equal(rec.handoff, null);
  assert.equal(rec.reg.status, "active");
  assert.equal(rec.reg.deadline, rec.reg.startedAt + 1_800_000);
  assert.equal(w.alarm(), rec.reg.deadline);
  w.clock += MIN;
  await txt(w, "lan@gmail.com");
  assert.equal(w.state().course, "banh-kem");
  assert.equal(w.state().gmail, "lan@gmail.com");
});

test("DN-07 the Admin types after pressing Hoàn thành: a new admin_reply ticket, the bot is silent again", async () => {
  const w = await handedByAlarm();
  adminDone(w);
  await adminEcho(w);
  assert.equal(w.tickets.at(-1).reason, "admin_reply");
  w.sent.length = 0;
  await txt(w, "cảm ơn");
  assert.deepEqual(w.sent, []);
});

test("DN-08 the reset writes nothing to orders or enrollments (only reads)", async () => {
  const w = await handedByAlarm();
  w.db.push({ id: "oA", slug: "banh-kem", status: "Đã duyệt", gmail: "lan@gmail.com" });
  const before = JSON.stringify(w.db);
  adminDone(w);
  await txt(w, "chào");
  assert.equal(JSON.stringify(w.db), before);
  assert.equal(w.created.length, 0);
});

// ======== E5 routing, pure bot ========
const ctx = (extra = {}) => ({ now: T0, courses: TWO, ticketsEnabled: true, faq: [], activeTicket: null, commerceUrl: "https://shop.example", ...extra });
const G = { ...emptyState(), greeted: true };
const T = (text, payload) => ({ kind: "text", text, ...(payload ? { payload } : {}) });
const P = (payload) => ({ kind: "postback", payload });
const CONFIRM = { ...G, course: "banh-mi", courseTitle: "Bánh mì Việt Nam", gmail: "lan@gmail.com" };
const BILL = { ...CONFIRM, gmailOk: true };

test("E5 F-A2 two misses offer an Admin and never a ticket; counters reset on any button and on understood text; fillers are silent", () => {
  let out = step(G, T("asdf qwer"), ctx());
  assert.equal(out.state.misses, 1);
  assert.match(textOf(out.replies.at(-1)), /Mình chưa hiểu ý bạn/);
  out = step(out.state, T("zxcv"), ctx());
  assert.equal(out.action, undefined);
  assert.match(textOf(out.replies[0]), /Phần này mình chưa có đủ thông tin/);
  assert.deepEqual(payloadsOf(out.replies[0]), ["HUMAN", "LIST", "MENU"]);
  out = step(out.state, T("zxcv zxcv"), ctx());
  assert.equal(out.action, undefined, "third miss: still an offer");
  for (const p of ["LIST", "DETAIL:banh-mi", "GMAIL_NO", "MENU"]) {
    const reset = step({ ...G, misses: 1 }, P(p), ctx());
    assert.equal(reset.state.misses, 0, p);
  }
  assert.equal(step({ ...G, misses: 1 }, T("học phí Bánh mì Việt Nam"), ctx()).state.misses, 0);
  for (const f of ["ok", "oke", "dạ", "vâng", "ừ", "cảm ơn shop", "thanks", "hihi", "Cảm ơn!"]) {
    const s = step({ ...G, misses: 1 }, T(f), ctx());
    assert.deepEqual(s.replies, [], f);
    assert.equal(s.action, undefined, f);
    assert.equal(s.state.misses, 0, f);
  }
  const first = step(emptyState(), T("ok"), ctx());
  assert.match(textOf(first.replies[0]), /trợ lý tự động/, "first contact still gets the greeting");
});

test("E5 F-A4 'đúng/ok/dạ' confirm and 'sai/nhầm' reject only at the Gmail confirmation step", () => {
  for (const yes of ["đúng", "đúng rồi", "ok", "oke", "vâng", "dạ", "dạ đúng", "yes", "phải", "chuẩn", "ừ"]) {
    assert.equal(step(CONFIRM, T(yes), ctx()).action?.type, "checkPayment", yes);
  }
  for (const no of ["sai", "không", "không đúng", "nhầm", "nhập lại"]) {
    const out = step(CONFIRM, T(no), ctx());
    assert.equal(out.state.gmail, null, no);
    assert.match(textOf(out.replies[0]), /gửi lại Gmail/, no);
  }
  const bill = step(BILL, T("ok"), ctx());
  assert.notEqual(bill.action?.type, "checkPayment", "'ok' at the bill step is not GMAIL_OK");
  assert.equal(step({ ...G, course: "banh-mi" }, T("ok"), ctx()).action, undefined, "no Gmail yet: just the step again");
});

test("E5 F-A6 near-names need 5+ letters, accent-free commands work, a title with punctuation matches without it", () => {
  const courses = [mk("chiffon", "Làm Chiffon"), mk("banh-kem", "Bánh kem cơ bản"), mk("khoa-b", "Khóa B – Làm bánh")];
  for (const t of ["khoa rảnh", "khoa bằng", "khoa đánh"]) assert.ok(!/Bạn muốn hỏi khóa Bánh/.test(textOf(step(G, T(t), ctx({ courses })).replies[0] || {})), t);
  assert.match(textOf(step(G, T("khoa chifon"), ctx({ courses })).replies[0]), /Bạn muốn hỏi khóa Làm Chiffon\?/);
  for (const t of ["gap admin", "gặp ad", "noi chuyen voi nguoi", "chat voi admin", "gặp người thật", "tu van vien"]) assert.deepEqual(step(G, T(t), ctx()).action, { type: "openTicket", reason: "human" }, t);
  const named = step(G, T("khoa b lam banh"), ctx({ courses }));
  assert.match(textOf(named.replies[0]), /Khóa B – Làm bánh/);
});

test("E5 F-A8 a typo of gmail.com asks 'Có phải ý bạn là…'; GMAIL_FIX corrects, GMAIL_KEEP keeps; other real domains are left alone", () => {
  const draft = { ...G, course: "banh-mi", courseTitle: "Bánh mì Việt Nam" };
  for (const bad of ["gmai.com", "gmail.con", "gmial.com", "gmail.co", "gamil.com"]) {
    const out = step(draft, T(`lan@${bad}`), ctx());
    assert.equal(textOf(out.replies[0]), "Có phải ý bạn là lan@gmail.com không?", bad);
    assert.deepEqual(payloadsOf(out.replies[0]).slice(0, 2), ["GMAIL_FIX", "GMAIL_KEEP"], bad);
    assert.equal(out.state.gmail, null);
    const fix = step(out.state, P("GMAIL_FIX"), ctx());
    assert.equal(fix.state.gmail, "lan@gmail.com");
    assert.match(textOf(fix.replies[0]), /bằng Gmail lan@gmail\.com\. Đúng không\?/);
    const keep = step(out.state, P("GMAIL_KEEP"), ctx());
    assert.equal(keep.state.gmail, `lan@${bad}`);
  }
  for (const ok of ["lan@yahoo.com", "lan@outlook.com", "lan@icloud.com", "lan@hotmail.com", "lan@gmail.com"]) {
    assert.ok(!/Có phải ý bạn/.test(textOf(step(draft, T(ok), ctx()).replies[0])), ok);
  }
  assert.match(textOf(step(draft, P("MENU"), ctx()).replies[0]), /Bạn cần mình giúp gì/);
});

test("E5 F-A9 money incidents open a support ticket with the customer's sentence; 'em vừa chuyển khoản rồi' does not", () => {
  const incidents = ["em chuyển nhầm tài khoản", "mình chuyển thiếu tiền", "chuyển dư 100k", "em chuyển thừa tiền", "chuyển 2 lần rồi", "chuyển hai lần", "chuyển trùng", "hoàn tiền giúp em", "trả lại tiền cho em", "giao dịch lỗi", "giao dịch thất bại", "bị trừ tiền", "ghi sai nội dung chuyển khoản", "em muốn đổi gmail"];
  assert.equal(incidents.length, 14);
  for (const state of [G, BILL]) for (const t of incidents.filter((x) => state === BILL || !/đổi gmail/.test(x))) {
    const out = step(state, T(t), ctx());
    assert.deepEqual(out.action, { type: "openTicket", reason: "support", summary: t }, t);
  }
  const no = step(BILL, T("em vừa chuyển khoản rồi"), ctx());
  assert.equal(no.action, undefined);
  assert.ok(adminIntent({ kind: "text", text: "chuyển nhầm" }));
  assert.ok(!adminIntent({ kind: "text", text: "em vừa chuyển khoản rồi" }));
});

test("E5 F-A3 'Chat với Admin' is one step: the next text or image opens the ticket (image summary fixed); old two-step buttons are aliases", () => {
  const ask = step(G, P("ADMIN"), ctx());
  assert.equal(textOf(ask.replies[0]), "Bạn mô tả ngắn việc cần Admin hỗ trợ nhé.");
  assert.deepEqual(payloadsOf(ask.replies[0]), ["ADMIN_SKIP", "MENU"]);
  assert.deepEqual(step(ask.state, T("không vào học được"), ctx()).action, { type: "openTicket", reason: "support", summary: "không vào học được" });
  assert.deepEqual(step(ask.state, { kind: "image", url: CDN }, ctx()).action, { type: "openTicket", reason: "support", summary: "Khách gửi ảnh, xem trong Hộp thư Trang." });
  assert.deepEqual(step(ask.state, T("Bỏ qua, gặp Admin", "ADMIN_SKIP"), ctx()).action, { type: "openTicket", reason: "support", summary: "" });
  for (const old of ["ADMIN_COURSE", "ADMIN_SUPPORT"]) assert.equal(step(G, P(old), ctx()).state.pendingAdmin, "support", old);
});

test("E5 F-A5 price / catalogue / buy wishes without a course name still work with the AI off", () => {
  const price = step(G, T("học phí bao nhiêu vậy shop"), ctx());
  assert.match(textOf(price.replies[0]), /Bạn xem học phí của từng khóa bên dưới nhé\./);
  assert.ok(price.replies.some((r) => r.attachment?.payload?.template_type === "generic"));
  for (const t of ["có những khóa nào", "xem khóa học", "danh sách khóa", "các khóa học"]) {
    assert.ok(step(G, T(t), ctx()).replies.some((r) => r.attachment?.payload?.template_type === "generic"), t);
  }
  assert.equal(step(G, T("tôi muốn đăng ký"), ctx()).action?.type, "checkCourse");
});

test("E5 F-A7 a lessons / content question about a named course shows the [Xem chi tiết] card; a typo asks first", () => {
  const exact = step(G, T("Bánh mì Việt Nam học những gì"), ctx());
  assert.match(textOf(exact.replies.at(-1)), /Bánh mì Việt Nam/);
  assert.match(textOf(exact.replies.at(-1)), /Mô tả khóa/);
  assert.equal(exact.action, undefined);
  const courses = [mk("chiffon", "Làm Chiffon")];
  const typo = step(G, T("khoa chifon day nhung gi"), ctx({ courses }));
  assert.deepEqual(payloadsOf(typo.replies[0]), ["DETAIL:chiffon", "LIST"]);
});

test("E5 F-A10 the account number is its own message, bank name and owner stay in the first", () => {
  const out = paymentInfo(BANH_MI, true);
  assert.match(out[0].text, /Chuyển khoản: VCB \(NGUYEN A\)/);
  assert.ok(!out[0].text.includes("0123456789"));
  assert.equal(out[1].text, "0123456789");
  assert.match(out.at(-1).text, /Bạn chụp ảnh bill/);
});

test("E5 F-A11 an image with no draft: T4 when there is no order, the 'extra image' action when there is one", () => {
  const none = step(G, { kind: "image", url: CDN }, ctx());
  assert.match(textOf(none.replies[0]), /chưa biết ảnh này thuộc đơn đăng ký nào/);
  assert.deepEqual(payloadsOf(none.replies[0]), ["ADMIN", "MENU"]);
  assert.equal(none.action, undefined);
  assert.equal(step({ ...G, orders: [{ id: "o1", slug: "banh-mi" }] }, { kind: "image", url: CDN }, ctx()).action?.type, "extraImage");
});

test("E5 bill step: same Gmail is plain text, another Gmail asks (T6) without stepping back, a reminder at most every 10 minutes, a sticker is silent, never a ticket or 'chưa hiểu'", () => {
  const same = step(BILL, T("chuyển rồi nhé, gmail lan@gmail.com"), ctx());
  assert.match(textOf(same.replies[0]), ASK);
  assert.equal(same.state.gmailOk, true);
  const again = step(same.state, T("đợi e xíu"), ctx({ now: T0 + 5 * MIN }));
  assert.deepEqual(again.replies, []);
  assert.match(textOf(step(again.state, T("em ck rồi"), ctx({ now: T0 + 11 * MIN })).replies[0]), ASK);
  const other = step(BILL, T("gmail hoa@gmail.com nhé"), ctx());
  assert.equal(textOf(other.replies[0]), "Bạn muốn đổi Gmail học thành hoa@gmail.com không? Nếu đã chuyển khoản, bạn gửi ảnh bill như bình thường nhé.");
  assert.deepEqual(payloadsOf(other.replies[0]), ["GMAIL_CHANGE", "GMAIL_KEEPOLD"]);
  assert.equal(other.state.gmailOk, true);
  assert.equal(other.state.gmail, "lan@gmail.com");
  assert.equal(step(other.state, { kind: "image", url: CDN }, ctx()).state.gmailPending, null);
  const img2 = step(other.state, { kind: "image", url: CDN }, ctx());
  assert.equal(img2.action.type, "createOrder");
  assert.equal(img2.state.gmail, "lan@gmail.com", "the order uses the confirmed Gmail");
  const change = step(other.state, P("GMAIL_CHANGE"), ctx());
  assert.deepEqual([change.state.gmail, change.state.gmailOk], ["hoa@gmail.com", false]);
  assert.equal(step(other.state, P("GMAIL_KEEPOLD"), ctx()).state.gmailPending, null);
  assert.deepEqual(step(BILL, { kind: "sticker" }, ctx()).replies, []);
  for (const t of ["xin chào bạn ơi hỏi tí", "asdf qwer", "e gửi", "nhận được chưa ạ"]) {
    const o = step(BILL, T(t), ctx());
    assert.ok(!o.action, t);
    assert.ok(!/chưa hiểu/.test(JSON.stringify(o.replies)), t);
  }
});

test("E5 U8 is gone: a long gap with a draft shows no 'Trước đó…' question", () => {
  const out = step({ ...CONFIRM, lastInboundAt: T0 - 100 * 3600_000 }, T("hi"), ctx());
  assert.ok(!JSON.stringify(out.replies).includes("Trước đó"));
});

// ======== orders view in the DO (F-A1) ========
test("E5 F-A1 'đơn của tôi' / learning trouble: T7 shows pending and approved orders (approved with the LMS link and the order's Gmail), T8 when there are none, busy on a DB error", async () => {
  const w = world();
  w.db.push({ id: "o1", slug: "banh-mi", status: "Chờ duyệt", gmail: "a@gmail.com" }, { id: "o2", slug: "banh-kem", status: "Đã duyệt", gmail: "lan@gmail.com" });
  await txt(w, "đơn của tôi");
  const m = w.sent.at(-1);
  assert.match(m.text, /^Đơn của bạn:\nBánh mì Việt Nam — Chờ duyệt \(gửi bill \d\d\/\d\d\/\d{4}\)\nBánh kem cơ bản — Đã duyệt: vào https:\/\/[^ ]+\/my-courses\.html, đăng nhập Google bằng lan@gmail\.com$/);
  assert.deepEqual(payloadsOf(m), ["ADMIN", "LIST_OTHER", "MENU"]);
  w.sent.length = 0;
  await txt(w, "em không vào học được");
  assert.match(w.sent.at(-1).text, /^Đơn của bạn:/);
  const none = world();
  await txt(none, "kiểm tra đơn");
  assert.equal(none.sent.at(-1).text, NO_ORDERS_TEXT);
  assert.deepEqual(payloadsOf(none.sent.at(-1)), ["ADMIN", "MENU"]);
  const down = world();
  down.dbDown = true;
  await press(down, "PENDING_ORDERS");
  assert.equal(down.sent.at(-1).text, "Hệ thống đang bận, bạn thử lại sau ít phút nhé.");
  assert.ok(payloadsOf(down.sent.at(-1)).includes("ADMIN"));
});

test("E5 F-A1 any text in the 30 minutes after an order is the orders view; after that, ordinary routing; unknown text with orders is no longer a pending list", async () => {
  const w = world();
  const reg = await toBill(w);
  w.at(reg.startedAt + 2 * MIN);
  await img(w);
  assert.ok(w.raw().postOrderUntil > w.clock);
  w.sent.length = 0;
  await txt(w, "cảm ơn shop nhé");
  assert.match(w.sent.at(-1).text, /^Đơn của bạn:/);
  w.sent.length = 0;
  w.clock += 31 * MIN;
  await txt(w, "asdf qwer");
  assert.match(textOf(w.sent.at(-1)), /Mình chưa hiểu ý bạn/);
});

test("loadMyOrders reads Chờ duyệt + Đã duyệt of this PSID and Page (or no page) with a limit, and refuses a blank page or odd PSID", async () => {
  const log = [];
  const db = { from: (table) => { const q = { table, eqs: [], ins: [], or: null }; const api = { select: () => api, in: (k, v) => { q.ins.push([k, v]); return api; }, eq: (k, v) => { q.eqs.push([k, v]); return api; }, or: (v) => { q.or = v; return api; }, order: () => api, limit: (l) => { q.lim = l; return api; }, abortSignal: () => api, then: (res) => { log.push(q); return res({ data: [{ id: "o1", course_slug: "banh-mi", course_title: "Bánh mì", customer_email: "a@gmail.com", status: "Đã duyệt", created_at: "2026-11-09T10:00:00Z", raw_data: { psid: PSID, pageId: PAGE } }], error: null }); } }; return api; } };
  const rows = await loadMyOrders({ psid: PSID, pageId: PAGE }, db);
  assert.equal(rows[0].email, "a@gmail.com");
  assert.deepEqual(log[0].ins, [["status", ["Chờ duyệt", "Đã duyệt"]]]);
  assert.deepEqual(log[0].eqs, [["raw_data->>psid", PSID]]);
  assert.equal(log[0].or, `raw_data->>pageId.eq.${PAGE},raw_data->>pageId.is.null`);
  await assert.rejects(loadMyOrders({ psid: PSID, pageId: "" }, db));
  await assert.rejects(loadMyOrders({ psid: "12", pageId: PAGE }, db));
  assert.equal(log.length, 1);
});

test("a storage without alarm support (old fakes) still works: no throw, the run is just not scheduled", async () => {
  const store = new Map();
  const w = world();
  const plain = new MessengerConversation({ storage: { async get(k) { return structuredClone(store.get(k)); }, async put(k, v) { store.set(k, structuredClone(v)); } } }, { META_PAGE_ACCESS_TOKEN: "t", META_APP_ID: "777", META_PAGE_ID: PAGE, MESSENGER_TICKETS_ENABLED: "1" }, w.c.deps);
  await plain.handle(PSID, ev({ text: "x", quick_reply: { payload: "BUY" } }));
  assert.ok(store.get("s").reg);
});

// ======== review fixes (opus-reviewer, 14/11) ========
test("RV-02 'đủ' (enough) is not 'dư' (too much): accented 'đủ' and unaccented 'du' are no incident; 'dư', 'thừa' and an unaccented amount still are", () => {
  for (const t of ["em chuyển đủ rồi", "chuyển đủ tiền rồi nhé", "em ck du roi", "chuyen du roi nhe"]) {
    assert.equal(step(BILL, T(t), ctx()).action, undefined, t);
    assert.equal(adminIntent({ kind: "text", text: t }), false, t);
  }
  for (const t of ["mình chuyển dư 100k", "em chuyển thừa tiền", "chuyen du 100k", "chuyen thua tien"]) assert.equal(step(BILL, T(t), ctx()).action?.reason, "support", t);
});

test("RV-03 a handoff 'pending' that nobody finished (crash): the alarm waits while it is fresh, then retries and opens the ticket", async () => {
  const w = world();
  const reg = await toBill(w);
  const rec = w.raw();
  const at = reg.deadline + 10;
  rec.reg = { ...rec.reg, status: "handing" };
  rec.handoff = { at, state: "pending", tries: 1, t1: true, retry: { pageId: PAGE, psid: PSID, reason: "support", summary: "x" } };
  await w.c.storage.put("s", rec);
  await w.c.storage.setAlarm(reg.deadline);
  await w.fireAlarm(at + 1000);
  assert.equal(w.tickets.length, 0);
  assert.equal(w.alarm(), at + 61_000);
  await w.fireAlarm(at + 61_000);
  assert.equal(w.tickets.length, 1);
  assert.equal(w.raw().handoff.state, "confirmed");
});

test("RV-04a the 30-minute handoff finding a ticket already open ('existing', an Admin holds the chat) sends no T1", async () => {
  const w = world({ deps: { openTicket: async () => ({ ok: true, existing: true }) } });
  const reg = await toBill(w);
  w.sent.length = 0;
  await w.fireAlarm(reg.deadline);
  assert.deepEqual(w.sent, []);
  assert.equal(w.raw().handoff.state, "confirmed");
});

test("RV-04b /offer always drops an old run (and its alarm) before it opens the fresh one", async () => {
  const w = world();
  const reg = await toBill(w);
  w.clock += 10 * MIN;
  const r = await w.c.offer(PSID, "banh-kem");
  assert.equal(r.status, 200);
  const fresh = w.raw().reg;
  assert.notEqual(fresh.id, reg.id);
  assert.equal(w.alarm(), fresh.deadline);
  assert.ok(fresh.deadline > reg.deadline);
});

test("RV-04d /offer of the same course as the open draft still opens a fresh run with its own alarm", async () => {
  const w = world();
  const reg = await toBill(w);
  const slug = w.raw().state.course;
  w.clock += 31 * MIN;
  const r = await w.c.offer(PSID, slug);
  assert.equal(r.status, 200);
  const fresh = w.raw().reg;
  assert.ok(fresh && fresh.status === "active");
  assert.notEqual(fresh.id, reg.id);
  assert.equal(w.alarm(), fresh.deadline);
  assert.equal(w.raw().state.course, slug);
});

test("RV-04c a run left 'handing' with no handoff record (crash between the two writes) is handed over at the next message, not silent forever", async () => {
  const w = world();
  await toBill(w);
  const rec = w.raw();
  rec.reg = { ...rec.reg, status: "handing" };
  rec.handoff = null;
  await w.c.storage.put("s", rec);
  w.sent.length = 0;
  await txt(w, "alo");
  assert.equal(w.tickets.length, 1);
  assert.equal(w.raw().reg.status, "handed");
  assert.ok(w.sentText().includes(HANDOFF_TEXT));
});

test("RV-05 an order made while a handoff ticket is still unwritten ('local') keeps a retry alarm instead of deleting it", async () => {
  const w = world();
  await toBill(w);
  w.orderGate = defer();
  const a = img(w);
  await settle();
  const rec = w.raw();
  rec.handoff = { at: w.clock, state: "local", tries: 1, retry: { pageId: PAGE, psid: PSID, reason: "support", summary: "x" } };
  await w.c.storage.put("s", rec);
  w.orderGate.resolve();
  await a;
  assert.equal(w.created.length, 1);
  assert.ok(w.alarm() !== null && w.alarm() > w.clock - 1);
});

test("RV-06 a handoff confirmed at the very millisecond the ticket read began: silent, not processed (>=)", async () => {
  const w = world({ deps: { now: () => 5_000 } });
  const rec = { state: { ...emptyState(), greeted: true, course: "banh-mi", gmail: "lan@gmail.com", gmailOk: true }, mids: [], hits: [], psid: PSID, reg: { id: "r", startedAt: 1, deadline: 9_999_999, status: "handed", pendingTicket: null }, handoff: { at: 4000, state: "confirmed", confirmedAt: 5_000, tries: 1 } };
  await w.c.storage.put("s", rec);
  await txt(w, "alo");
  assert.deepEqual(w.sent, []);
  assert.equal(w.raw().reg.status, "handed");
  assert.equal(w.state().course, "banh-mi");
});

test("RV-07 an order error after the deadline: the handoff ticket says so, and keeps what the customer asked meanwhile", async () => {
  const w = world();
  const reg = await toBill(w);
  w.orderGate = defer();
  w.orderStatus = 500;
  w.at(reg.deadline - 2000);
  const a = img(w);
  await settle();
  await txt(w, "em chuyển nhầm tài khoản");
  w.at(reg.deadline + 5000);
  w.orderGate.resolve();
  await a;
  assert.equal(w.tickets.length, 1);
  assert.match(w.tickets[0].summary, /Khách đã gửi bill trước hạn nhưng tạo đơn lỗi sau hạn/);
  assert.match(w.tickets[0].summary, /Khách cũng nhắn: em chuyển nhầm tài khoản/);
});

test("RV-08 a request for an Admin during the upload is kept even without a run (legacy draft) and opened after the order", async () => {
  const w = world({ state: { course: "banh-mi", courseTitle: "Bánh mì Việt Nam", gmail: "lan@gmail.com", gmailOk: true } });
  assert.equal(w.raw().reg, undefined);
  w.orderGate = defer();
  const a = img(w);
  await settle();
  await txt(w, "gặp admin");
  w.orderGate.resolve();
  await a;
  assert.equal(w.created.length, 1);
  assert.equal(w.tickets.length, 1);
  assert.equal(w.sentText().at(-1), TICKET_OK_TEXT);
});

test("RV-09 'đổi gmail' is an incident only at the bill step or for a customer with orders; at the Gmail steps it is not a ticket", () => {
  const draft = { ...G, course: "banh-mi", courseTitle: "Bánh mì Việt Nam" };
  assert.equal(step(draft, T("em muốn đổi gmail"), ctx()).action?.type, undefined);
  assert.equal(step(CONFIRM, T("em muốn đổi gmail"), ctx()).action?.type, undefined);
  assert.equal(step(BILL, T("em muốn đổi gmail"), ctx()).action?.reason, "support");
  assert.equal(step({ ...G, orders: [{ id: "o1", slug: "banh-mi" }] }, T("em muốn đổi gmail"), ctx()).action?.reason, "support");
});

test("RV-10 'chất' is not 'chat': a question about quality is no Admin request; 'chat với admin' still is", () => {
  assert.equal(step(G, T("khoá này chất lượng cho người mới không"), ctx()).action?.reason, undefined);
  assert.equal(step(BILL, T("chất lượng khoá này sao admin"), ctx()).action?.reason, undefined);
  for (const t of ["chat với admin", "chat voi admin", "chat với người thật"]) assert.deepEqual(step(G, T(t), ctx()).action, { type: "openTicket", reason: "human" }, t);
});

test("RV-11 a customer with orders and an AI that gave no usable answer gets the orders view (myOrders)", async () => {
  const { aiReply } = await import("../utils/messenger/bot.js");
  assert.equal(aiReply({ ...G, orders: [{ id: "o1", slug: "banh-mi" }] }, null, ctx()).action?.type, "myOrders");
});

test("RV-12 inside the 30 minutes after an order, a clear wish to buy a named course goes on as usual; everything else is still the orders view", () => {
  const state = { ...G, orders: [{ id: "o1", slug: "banh-mi" }] };
  const c = ctx({ postOrderUntil: T0 + 10 * MIN });
  assert.equal(step(state, T("tôi muốn đăng ký Bánh kem cơ bản"), c).action?.type, "checkCourse");
  assert.equal(step(state, T("cảm ơn shop"), c).action?.type, "myOrders");
  assert.equal(step(state, T("học phí Bánh kem cơ bản"), c).action?.type, "myOrders");
  assert.equal(step(state, T("hi"), c).action, undefined);
  assert.match(textOf(step(state, T("hi"), c).replies.at(-1)), /Bạn cần mình giúp gì/);
});
