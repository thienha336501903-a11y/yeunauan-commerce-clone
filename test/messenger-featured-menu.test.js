// Featured-course button on the main menu (Owner 14/11): first button = BUY:<slug> of the sellable featured course.
import test from "node:test";
import assert from "node:assert/strict";
import { step, stepRaw, emptyState, renderReplies, menuButtons, FEATURED_SHORT, featuredLine, MENU3 } from "../utils/messenger/bot.js";
import { MessengerConversation } from "../cloudflare/commerce-worker/src/messenger.js";

const PSID = "1234567890123";
const PAGE = "555";
const mk = (slug, title, featured = false) => ({ slug, title, price: "100.000đ", bankName: "VCB", bankAccount: "0123", bankOwner: "X", transferNote: slug, qrImageUrl: "", imageUrl: "", featured });
const SHORT = mk("khoa-ngan", "Bánh mì", true);
const LONG_TITLE = "Khóa làm bánh mì Việt Nam từ A đến Z";
const LONG = mk("khoa-dai", LONG_TITLE, true);
const OTHER = mk("khoa-a", "Khóa A");
const ctx = (courses, extra = {}) => ({ now: 1_000_000, courses, ticketsEnabled: true, faq: [], activeTicket: null, commerceUrl: "https://shop.example", ...extra });
const G = { ...emptyState(), greeted: true };
const txt = (text) => ({ kind: "text", text });
const pb = (payload) => ({ kind: "postback", payload });
const buttons = (m) => [...(m.attachment?.payload?.buttons || []), ...(m.quick_replies || [])];
const payloads = (m) => buttons(m).map((q) => q.payload);
const textOf = (m) => m.text ?? m.attachment?.payload?.text;
const hi = (c, st = G) => step(st, txt("hi"), c).replies.at(-1);

test("FM-1 featured title <= 20 chars: button = exact title, payload BUY:<slug>; text has the featured line", () => {
  assert.ok([...SHORT.title].length <= 20);
  const m = hi(ctx([SHORT, OTHER]));
  assert.deepEqual(buttons(m).map((q) => [q.title, q.payload]).slice(0, 3), [[SHORT.title, "BUY:khoa-ngan"], ["Xem khóa đang mở bán", "LIST"], ["Chat với Admin", "ADMIN"]]);
  assert.ok(textOf(m).includes(`Khóa nổi bật: ${SHORT.title}.`));
  assert.match(textOf(m), /Khóa nổi bật: Bánh mì\.\nBạn cần mình giúp gì\?$/);
});

test("FM-2 featured title > 20 chars: button 'Đăng ký khóa này', full title in the text, no ellipsis in any button", () => {
  assert.ok([...LONG_TITLE].length > 20);
  const m = hi(ctx([LONG, OTHER]));
  assert.equal(FEATURED_SHORT, "Đăng ký khóa này");
  assert.deepEqual([buttons(m)[0].title, buttons(m)[0].payload], ["Đăng ký khóa này", "BUY:khoa-dai"]);
  assert.ok(textOf(m).includes(`Khóa nổi bật: ${LONG_TITLE}.`));
  assert.ok(buttons(m).every((q) => !q.title.includes("…") && [...q.title].length <= 20));
});

test("FM-3 no featured course, or tickets off: old first button and no featured line", () => {
  // tickets off: the bot never builds this menu itself (legacy course quick replies), so render the placeholder directly
  const off = renderReplies([{ menu: { intro: "", extra: [], ask: true } }], { pendingMenu: "hide", doOrderIds: [] }, ctx([SHORT], { ticketsEnabled: false })).at(-1);
  for (const m of [hi(ctx([OTHER])), hi(ctx([])), off]) {
    assert.deepEqual([buttons(m)[0].title, buttons(m)[0].payload], ["Đăng ký khóa học", "BUY"]);
    assert.ok(!textOf(m).includes("Khóa nổi bật"));
  }
  assert.deepEqual(menuButtons("hide", false), MENU3);
  assert.equal(featuredLine(null), "");
});

test("FM-4 pending order: 4 options [featured, LIST, PENDING_ORDERS, ADMIN], the 4th as a quick reply", () => {
  const raw = stepRaw(G, txt("hi"), ctx([SHORT])).replies.at(-1);
  const m = renderReplies([raw], { pendingMenu: "show", doOrderIds: [] }, ctx([SHORT])).at(-1);
  assert.deepEqual(payloads(m), ["BUY:khoa-ngan", "LIST", "PENDING_ORDERS", "ADMIN"]);
  assert.equal(m.attachment.payload.buttons.length, 3);
  assert.deepEqual(m.quick_replies.map((q) => q.payload), ["ADMIN"]);
});

test("FM-5 BUY:<slug> of a sellable course that is no longer featured opens THAT course", () => {
  const c = ctx([SHORT, OTHER]);
  const out = step(G, pb("BUY:khoa-a"), c);
  assert.equal(out.action.type, "checkCourse");
  assert.equal(out.action.slug, "khoa-a");
  // the featured course now changed: the old button of SHORT still names SHORT
  const out2 = step(G, pb("BUY:khoa-ngan"), ctx([mk("khoa-ngan", "Bánh mì"), mk("khoa-a", "Khóa A", true)]));
  assert.equal(out2.action.slug, "khoa-ngan");
});

test("FM-6 BUY:<slug> of a course no longer sellable: 'chưa mở đăng ký' list, no draft, no reg", () => {
  const out = step(G, pb("BUY:khoa-cu"), ctx([SHORT, OTHER]));
  assert.ok(!out.action);
  assert.equal(out.state.course, null);
  assert.equal(out.state.reg, undefined);
  assert.ok(JSON.stringify(out.replies).includes("Khóa này hiện chưa mở đăng ký."));
});

function world(courses) {
  let alarm = null;
  const store = new Map();
  const w = { sent: [], touched: [], ticket: null, clock: 1_800_000_000_000 };
  const storage = {
    async get(k) { return structuredClone(store.get(k)); },
    async put(k, v) { store.set(k, structuredClone(v)); },
    async setAlarm(t) { alarm = t; },
    async getAlarm() { return alarm; },
    async deleteAlarm() { alarm = null; }
  };
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body);
    if (b.message) w.sent.push(b.message);
    return new Response('{"message_id":"m"}', { status: 200 });
  };
  w.c = new MessengerConversation({ storage }, { META_PAGE_ACCESS_TOKEN: "t", META_APP_ID: "777", META_PAGE_ID: PAGE, MESSENGER_BOT_ENABLED: "1", MESSENGER_TICKETS_ENABLED: "1" }, {
    fetchImpl, now: () => (w.clock += 1), loadFaq: () => [],
    touchTicket: async (id) => { w.touched.push(id); },
    loadCourses: async () => courses,
    activeTicket: async () => w.ticket,
    loadCourseOrders: async () => [], loadPendingOrders: async () => [], loadMyOrders: async () => [], loadOrder: async () => null
  });
  w.raw = () => store.get("s");
  w.alarm = () => alarm;
  return w;
}
let n = 0;
const press = (w, payload) => w.c.handle(PSID, { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: ++n, message: { mid: `m${n}`, text: "x", quick_reply: { payload } } });
const say = (w, text) => w.c.handle(PSID, { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: ++n, message: { mid: `m${n}`, text } });

test("FM-7 showing the menu starts no run: 'hi' sets no reg and no alarm; tapping the featured button opens the draft and sets reg", async () => {
  const w = world([SHORT, OTHER]);
  await say(w, "hi");
  assert.equal(w.raw().reg, undefined);
  assert.equal(w.alarm(), null);
  assert.equal(buttons(w.sent.at(-1))[0].payload, "BUY:khoa-ngan");
  await press(w, "BUY:khoa-ngan");
  assert.equal(w.raw().state.course, "khoa-ngan");
  assert.ok(w.raw().reg);
  assert.equal(w.alarm(), w.raw().reg.deadline);
});

test("FM-8 open ticket: tapping BUY:<slug> is silent (touchTicket, no reply)", async () => {
  const w = world([SHORT, OTHER]);
  w.ticket = { id: "t1", status: "open" };
  await press(w, "BUY:khoa-ngan");
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.touched, ["t1"]);
  const out = step(G, pb("BUY:khoa-ngan"), ctx([SHORT], { activeTicket: { id: "t1" } }));
  assert.deepEqual(out.replies, []);
  assert.deepEqual(out.action, { type: "touchTicket" });
});

test("FM-9 very long intro: template text <= 640 and the featured line is kept", () => {
  const c = ctx([LONG]);
  const view = { pendingMenu: "hide", doOrderIds: [] };
  for (const ask of [true, false]) {
    const out = renderReplies([{ menu: { intro: "Các đơn của bạn: " + "x".repeat(700) + "\n", extra: [], ask } }], view, c);
    const tpl = out.at(-1);
    assert.ok(textOf(tpl).length <= 640, `ask=${ask}`);
    assert.ok(textOf(tpl).includes(`Khóa nổi bật: ${LONG_TITLE}.`), `ask=${ask}`);
    assert.equal(buttons(tpl)[0].payload, "BUY:khoa-dai");
  }
});

test("FM-10 ask:false text (greeting, busy): intro, blank line, featured line; no featured line without a featured course", () => {
  const view = { pendingMenu: "hide", doOrderIds: [] };
  const greet = stepRaw(emptyState(), pb("GET_STARTED"), ctx([SHORT])).replies[0];
  const withF = textOf(renderReplies([greet], view, ctx([SHORT]))[0]);
  const without = textOf(renderReplies([greet], view, ctx([OTHER]))[0]);
  assert.equal(withF, `${without}\n\nKhóa nổi bật: Bánh mì.`);
  assert.ok(!without.includes("Khóa nổi bật"));
  const g2 = textOf(step(emptyState(), pb("GET_STARTED"), ctx([mk("khoa-b", "Khóa B", true)])).replies[0]);
  assert.equal(g2, "Chào bạn! 👋 Mình là trợ lý tự động của Yêu học bánh. Bạn muốn đăng ký khóa học hay cần hỗ trợ gì ạ?\n\nKhóa nổi bật: Khóa B.");
});

test("FM-11 title clean-up: emoji counted as 2 (UTF-16), multi-line and decomposed (macOS) titles become one NFC line; HTML removed", () => {
  const f = (title) => menuButtons("hide", false, [], { slug: "k", title })[0][0];
  assert.equal(f("Bánh mì 🍞🍞🍞🍞🍞🍞"), "Bánh mì 🍞🍞🍞🍞🍞🍞"); // 8 + 12 = 20 UTF-16 units
  assert.equal(f("Bánh mì 🍞🍞🍞🍞🍞🍞🍞"), FEATURED_SHORT); // 22 units: never cut
  assert.equal(f("Bánh\nmì   Việt"), "Bánh mì Việt");
  assert.equal(f("Bánh mì".normalize("NFD")), "Bánh mì");
  assert.equal(f("<b>Bánh</b> mì"), "Bánh mì");
  assert.equal(featuredLine({ slug: "k", title: "Bánh\nmì" }), "Khóa nổi bật: Bánh mì.\n");
  for (const t of ["Bánh mì Việt Nam cơ bản 🍞", "x".repeat(50)]) assert.ok(f(t).length <= 20, t);
});
