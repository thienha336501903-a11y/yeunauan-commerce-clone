// Port of the 132-case bill-race probe (bill-race-probe-20261113.mjs) with the G-LIVE-ux expectations (rulebook E6).
// Fake storage (with alarm), fake DB, fake Meta. Every case is one test; the id is in the name.
import test from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../utils/messenger/bot.js";
import { MessengerConversation } from "../cloudflare/commerce-worker/src/messenger.js";

const PSID = "1234567890123";
const PAGE = "555";
const T0 = Date.UTC(2026, 10, 13, 5);
const H = 3600e3;
const MIN = 60e3;
const CDN = "https://scontent.xx.fbcdn.net/x";
const mk = (slug, title, extra = {}) => ({ slug, title, price: "199.000đ", description: "Mô tả", subtitle: "", bankName: "VCB", bankAccount: "0123456789", bankOwner: "NGUYEN A", transferNote: `HOC ${slug}`, ...extra });
const TWO = [mk("banh-mi", "Bánh mì Việt Nam", { featured: true }), mk("banh-kem", "Bánh kem cơ bản")];
const ONE = [TWO[0]];
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
const defer = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
const show = (m) => {
  const q = (m.quick_replies || []).map((x) => `(${x.title || x.content_type})`).join("");
  if (m.text) return `"${m.text}" ${q}`.trim();
  const p = m.attachment?.payload;
  if (p?.template_type === "button") return `"${p.text}" ${p.buttons.map((b) => `[${b.title}]`).join("")}${q}`;
  if (p?.template_type === "generic") return `<băng thẻ ${p.elements.length} khoá: ${p.elements.map((e) => e.title).join(", ")}> ${q}`.trim();
  if (m.attachment?.type === "image") return "<ảnh>";
  return JSON.stringify(m);
};

// A real run at the bill step (BUY -> Gmail -> Đúng), so reg, alarm and deadline exist like in production.
async function world({ courses = TWO, env = {}, deps = {}, gmail = "lan@gmail.com" } = {}) {
  let alarm = null;
  const store = new Map([["s", { state: { ...emptyState(), greeted: true, lastInboundAt: T0 - 1000 }, mids: [], hits: [] }]]);
  const w = { sent: [], created: [], tickets: [], db: [], clock: T0, ticket: null, courses };
  const storage = {
    async get(k) { return structuredClone(store.get(k)); }, async put(k, v) { store.set(k, structuredClone(v)); },
    async setAlarm(t) { alarm = t; }, async getAlarm() { return alarm; }, async deleteAlarm() { alarm = null; }
  };
  const fetchImpl = async (url, init) => {
    if (String(url).includes("graph.facebook.com")) { const b = JSON.parse(init.body); if (b.message) w.sent.push(show(b.message)); return new Response('{"message_id":"m"}', { status: 200 }); }
    if (w.download) await w.download.p;
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
  };
  const row = (o) => ({ id: o.id, slug: o.slug, status: "Chờ duyệt", title: w.courses.find((c) => c.slug === o.slug)?.title || o.slug, email: o.gmail, createdAt: new Date(T0).toISOString(), psid: PSID, pageId: PAGE });
  w.c = new MessengerConversation({ storage }, { META_PAGE_ACCESS_TOKEN: "t", META_APP_ID: "777", META_PAGE_ID: PAGE, MESSENGER_BOT_ENABLED: "1", MESSENGER_TICKETS_ENABLED: "1", ...env }, {
    fetchImpl, now: () => (w.clock += 5), loadFaq: () => [], touchTicket: async () => {},
    loadCourses: async () => { if (w.coursesGate) { const g = w.coursesGate; w.coursesGate = null; await g.p; } return w.courses; },
    activeTicket: async () => w.ticket,
    openTicket: async (a) => { w.tickets.push(`${a.reason}: ${a.summary || ""}`.slice(0, 90)); w.ticket = { id: "t1", status: a.status || "open" }; return { ok: true }; },
    loadCourseOrders: async ({ slug }) => { if (w.dbDown) throw new Error("db"); return w.db.filter((o) => o.slug === slug).map(row); },
    loadPendingOrders: async () => { if (w.dbDown) throw new Error("db"); return w.db.map(row); },
    loadMyOrders: async () => { if (w.dbDown) throw new Error("db"); return w.db.map(row); },
    loadOrder: async (id) => { const o = w.db.find((x) => x.id === id); return o ? { status: "Chờ duyệt", course_slug: o.slug, course_title: o.slug, customer_email: o.gmail } : null; },
    createBillOrder: async (x) => { if (w.orderGate) await w.orderGate.p; if (w.orderStatus) return { status: w.orderStatus, body: { code: "x" } }; const id = `o${w.db.length + 1}`; w.db.push({ id, slug: x.course, gmail: x.gmail }); w.created.push(id); return { status: 200, body: { orderId: id } }; },
    ...deps
  });
  w.state = () => store.get("s").state;
  w.raw = () => store.get("s");
  w.alarm = () => alarm;
  w.fireAlarm = async (at) => { w.clock = at; if (alarm !== null && alarm <= at) { alarm = null; await w.c.alarm(); } };
  const send = (message, mid) => w.c.handle(PSID, { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, message: { mid: mid || `m${++w.n}`, ...message } });
  w.n = 0;
  w.img = (mid) => send({ attachments: [{ type: "image", payload: { url: CDN } }] }, mid);
  w.txt = (text) => send({ text });
  w.like = () => send({ sticker_id: 369239263222822, attachments: [{ type: "image", payload: { url: CDN, sticker_id: 369239263222822 } }] });
  w.press = (payload) => send({ text: "x", quick_reply: { payload } });
  w.album = () => send({ attachments: [{ type: "image", payload: { url: CDN } }, { type: "image", payload: { url: CDN } }] });
  await w.press("BUY");
  await w.txt(gmail);
  await w.press("GMAIL_OK");
  w.reg = w.raw().reg;
  w.sent.length = 0;
  return w;
}
const has = (w, re) => w.sent.some((m) => re.test(m));
const idx = (w, re) => w.sent.findIndex((m) => re.test(m));
const ASK = /Bạn chụp ảnh bill chuyển khoản|gửi ảnh chụp bill vào đây/;
const GOT = /Mình đã nhận bill/;
const T7 = /^"Đơn của bạn:/;
const UNSURE = /chưa hiểu/;
const normal = (w) => {
  assert.equal(w.created.length, 1, "đúng 1 đơn");
  assert.ok(!w.state().course, "nháp đã dùng xong");
  assert.equal(w.tickets.length, 0, `không ticket vô cớ: ${w.tickets.join(" || ")}`);
  assert.ok(has(w, GOT), "có câu nhận bill");
  assert.ok(!(idx(w, GOT) >= 0 && w.sent.slice(idx(w, GOT) + 1).some((m) => ASK.test(m))), "không nhắc gửi bill sau khi đã nhận");
};

const PHRASES = ["e gửi", "em gửi ạ", "em ck rồi", "mình thanh toán rồi nhé", "shop check giúp em", "bill đây", "gửi rồi nhé", "nãy bận giờ mới gửi", "em ck từ sáng mà quên gửi bill", "chị chuyển khoản hôm qua rồi", "mình vừa gửi biên lai đó", "shop nhận được chưa ạ?",
  "e gui r nha", "da ck roi a", "ck r nhe shop", "e chuyen khoan roi do", "Em chuyển khoản từ sáng mà giờ mới rảnh gửi ảnh, shop kiểm tra giúp em nhé.", "Mình thanh toán rồi, nãy bận chưa gửi bill.", "ok", "dạ", "cảm ơn shop", "xong rồi nha", "đã chuyển 199k", "chuyển rồi nhé, gmail lan@gmail.com"];
const PROBLEMS = ["em chuyển thiếu tiền rồi", "mình chuyển dư 100k", "em ghi sai nội dung chuyển khoản", "em chuyển nhầm tài khoản", "em lỡ chuyển 2 lần", "hoàn tiền giúp em", "giao dịch thất bại mà bị trừ tiền"];

// ---- A: image first, text after ----
for (const courses of [TWO, ONE]) {
  const tag = courses === ONE ? "1 khoá" : "2 khoá";
  test(`A1 (${tag}) ảnh xong → 'e gửi' : 1 đơn, câu 'đơn của tôi' (T7), không nhắc gửi bill`, async () => {
    const w = await world({ courses });
    await w.img(); await w.txt("e gửi");
    normal(w);
  });
  test(`D1 (${tag}) ảnh xong → câu dài 'Em chuyển khoản từ sáng…' : T7 (G-LIVE-ux A6 bước 10), không đưa khoá khác`, async () => {
    const w = await world({ courses });
    await w.img(); await w.txt(PHRASES[16]);
    normal(w);
    assert.ok(!has(w, /Bạn muốn hỏi khóa|băng thẻ/));
    assert.ok(has(w, T7));
  });
}
test("A2 ảnh đang tạo đơn → 'e gửi' đến giữa chừng: chỉ câu nhận bill (chữ im)", async () => {
  const w = await world(); w.orderGate = defer(); const a = w.img(); await settle(); const b = w.txt("e gửi"); await settle(); w.orderGate.resolve(); await Promise.all([a, b]);
  normal(w); assert.ok(!has(w, ASK));
});
test("A2b ảnh đang tạo đơn → 👍 đến giữa chừng: chỉ câu nhận bill", async () => {
  const w = await world(); w.orderGate = defer(); const a = w.img(); await settle(); const b = w.like(); await settle(); w.orderGate.resolve(); await Promise.all([a, b]);
  normal(w); assert.ok(!has(w, ASK));
});
test("D2 ảnh đang tạo đơn → câu dài đến giữa chừng: chỉ câu nhận bill", async () => {
  const w = await world(); w.orderGate = defer(); const a = w.img(); await settle(); const b = w.txt(PHRASES[16]); await settle(); w.orderGate.resolve(); await Promise.all([a, b]);
  normal(w); assert.ok(!has(w, ASK));
});
test("A3 đảo thứ tự: ảnh gửi trước nhưng 'e gửi' được xử lý trước: 1 nhắc rồi 1 đơn", async () => {
  const w = await world(); w.coursesGate = defer(); const g = w.coursesGate; const a = w.img(); await settle(); const b = w.txt("e gửi"); await settle(); g.resolve(); await Promise.all([a, b]);
  normal(w);
});
test("A4 ảnh đang tạo đơn → 3 tin chữ liên tiếp: 1 đơn, 0 ticket, không 'chưa hiểu'", async () => {
  const w = await world(); w.orderGate = defer(); const a = w.img(); await settle(); const t = []; for (const p of ["e gửi", "shop check giúp em", "nhận được chưa ạ"]) { t.push(w.txt(p)); await settle(); } w.orderGate.resolve(); await Promise.all([a, ...t]);
  normal(w); assert.ok(!has(w, ASK)); assert.ok(!has(w, UNSURE));
});

// ---- B/C: text first, image after ----
test("B1 'e gửi' → ảnh (tuần tự)", async () => { const w = await world(); await w.txt("e gửi"); await w.img(); normal(w); });
test("B2 'e gửi' và ảnh cùng lúc", async () => { const w = await world(); const a = w.txt("e gửi"); const b = w.img(); await Promise.all([a, b]); normal(w); });
test("C1 'Mình thanh toán rồi, nãy bận chưa gửi bill.' → ảnh", async () => { const w = await world(); await w.txt(PHRASES[17]); await w.img(); normal(w); });
test("B3 2 tin chữ → ảnh: 1 lần nhắc rồi im, 1 đơn, không 'chưa hiểu'", async () => {
  const w = await world(); await w.txt("e gửi"); await w.txt("em ck rồi"); await w.img(); normal(w); assert.ok(!has(w, UNSURE));
  assert.equal(w.sent.filter((m) => ASK.test(m)).length, 1);
});
test("B4 3 tin chữ → ảnh: 1 đơn, 0 ticket", async () => { const w = await world(); await w.txt("e gửi"); await w.txt("em ck rồi"); await w.txt("đợi e xíu"); await w.img(); normal(w); assert.ok(!has(w, UNSURE)); });
test("B5 tin chữ có nhắc lại đúng Gmail → ảnh: không lùi bước, 1 đơn", async () => {
  const w = await world(); await w.txt("chuyển rồi nhé, gmail lan@gmail.com"); await w.img(); normal(w); assert.ok(!has(w, /Đúng không\?/));
});

// ---- E: phrases ----
for (const p of PHRASES) {
  test(`E-trước bước chờ bill, chưa gửi ảnh: "${p}" — ≤ 1 nhắc, giữ nguyên bước bill, không ticket, không lùi Gmail`, async () => {
    const w = await world(); await w.txt(p);
    assert.ok(w.sent.filter((m) => ASK.test(m)).length <= 1);
    assert.equal(w.state().gmailOk, true);
    assert.equal(w.state().course, "banh-mi");
    assert.equal(w.tickets.length, 0);
    assert.ok(!has(w, UNSURE));
    assert.ok(!has(w, /Đúng không\?/), "Gmail trùng không hỏi lại");
  });
}
for (const courses of [TWO, ONE]) for (const p of PHRASES) {
  test(`E-sau (${courses.length} khoá) đã có đơn chờ duyệt: "${p}" — T7`, async () => {
    const w = await world({ courses }); await w.img(); w.sent.length = 0; await w.txt(p);
    assert.ok(w.sent.some((m) => T7.test(m)), w.sent.join(" | "));
    assert.ok(!has(w, /Bạn muốn hỏi khóa|băng thẻ|chưa hiểu/));
    assert.equal(w.tickets.length, 0);
  });
}
for (const p of PROBLEMS) {
  test(`P-trước sự cố tiền ở bước chờ bill: "${p}" — ticket ngay`, async () => {
    const w = await world(); await w.txt(p); assert.equal(w.tickets.length, 1); assert.match(w.tickets[0], /^support: /); assert.equal(w.raw().reg.status, "handed"); assert.equal(w.alarm(), null);
  });
  test(`P-sau sự cố tiền khi đã có đơn: "${p}" — ticket ngay`, async () => {
    const w = await world(); await w.img(); w.sent.length = 0; await w.txt(p); assert.equal(w.tickets.length, 1);
  });
}

// ---- F: time (the gap is now measured from the run's start: after 30 minutes the run was handed over) ----
for (const [label, gap] of [["5 phút", 5 * MIN], ["5 giờ", 5 * H], ["11 giờ 59", 12 * H - MIN], ["12 giờ", 12 * H], ["13 giờ", 13 * H], ["30 giờ", 30 * H]]) {
  const inRun = gap < 30 * MIN;
  const check = (w) => {
    if (inRun) { normal(w); return; }
    // G-LIVE-ux O1/O7/O9: the run was handed over at minute 30; the bill after it is silent for the bot, the Admin handles it.
    assert.equal(w.created.length, 0);
    assert.equal(w.tickets.length, 1);
    assert.match(w.tickets[0], /chưa hoàn tất sau 30 phút/);
    assert.equal(w.sent.filter((m) => /Đã hết thời gian đăng ký tự động/.test(m)).length, 1);
    assert.ok(!has(w, GOT));
  };
  test(`F-${label} ảnh→chữ`, async () => { const w = await world(); w.clock += gap; await w.img(); await w.txt("e gửi"); check(w); });
  test(`F-${label} chữ→ảnh`, async () => { const w = await world(); w.clock += gap; await w.txt("e gửi"); await w.img(); check(w); });
}
test("F-paused chữ→ảnh sau 13 giờ, khoá vừa ngừng bán: đã bàn giao ở phút 30 → ticket, 0 đơn", async () => {
  const w = await world(); w.courses = [TWO[1]]; w.clock += 13 * H; await w.txt("em ck rồi"); await w.img();
  assert.equal(w.tickets.length, 1); assert.equal(w.created.length, 0);
});
test("F-paused ảnh→chữ sau 13 giờ, khoá vừa ngừng bán: đã bàn giao ở phút 30 → ticket, 0 đơn", async () => {
  const w = await world({ deps: { createBillOrder: async () => ({ status: 409, body: { code: "sale_paused" } }) } }); w.courses = [TWO[1]]; w.clock += 13 * H; await w.img(); await w.txt("em ck rồi");
  assert.equal(w.tickets.length, 1); assert.equal(w.created.length, 0);
});
test("F-paused (extra, trong hạn): ảnh → 409 → ticket 'khóa này hiện chưa nhận đăng ký', run bàn giao", async () => {
  const w = await world({ deps: { createBillOrder: async () => ({ status: 409, body: { code: "sale_paused" } }) } }); await w.img();
  assert.equal(w.tickets.length, 1); assert.match(w.tickets[0], /không nhận đăng ký/); assert.ok(has(w, /chưa nhận đăng ký/)); assert.equal(w.raw().reg.status, "handed");
});

// ---- F: duplicates, retries, slowness ----
test("F-dup-webhook Meta gửi lại cùng webhook (cùng mid), tuần tự", async () => { const w = await world(); await w.img("same"); await w.img("same"); normal(w); });
test("F-dup-webhook-đồng thời cùng mid, bản 2 đến khi bản 1 đang tạo đơn", async () => {
  const w = await world(); w.orderGate = defer(); const a = w.img("same2"); await settle(); const b = w.img("same2"); await settle(); w.orderGate.resolve(); await Promise.all([a, b]); normal(w); assert.equal(w.sent.length, 1);
});
test("F-2 ảnh sát nhau: ảnh thứ 2 (mid khác) khi ảnh 1 đang tạo đơn → 'đang xử lý', 1 đơn", async () => {
  const w = await world(); w.orderGate = defer(); const a = w.img(); await settle(); const b = w.img(); await settle(); w.orderGate.resolve(); await Promise.all([a, b]); normal(w);
  assert.ok(has(w, /đang xử lý bill/));
});
test("F-gửi lại ảnh sau khi đã có đơn: không đơn thứ 2, ticket 'ảnh thêm' (B7)", async () => {
  const w = await world(); await w.img(); await w.img();
  assert.equal(w.created.length, 1); assert.equal(w.tickets.length, 1); assert.match(w.tickets[0], /gửi thêm ảnh/);
});
test("F-3 ảnh + chữ: 1 đơn, 1 ticket 'ảnh thêm', phần còn lại im", async () => {
  const w = await world(); await w.img(); await w.img(); await w.img(); await w.txt("e gửi");
  assert.equal(w.created.length, 1); assert.equal(w.tickets.length, 1);
});
test("F-album 2 ảnh trong MỘT tin rồi 'e gửi': 1 đơn + 1 ticket 'chỉ lấy ảnh đầu'", async () => {
  const w = await world(); await w.album(); await w.txt("e gửi");
  assert.equal(w.created.length, 1); assert.equal(w.tickets.length, 1); assert.match(w.tickets[0], /2 ảnh trong một tin/);
});
test("F-timeout tạo đơn quá giờ → khách hỏi (im) → đơn ghi muộn → Admin đóng ticket → khách gửi lại ảnh: đúng 1 đơn, không bắt chuyển khoản lại", async () => {
  const w = await world({ deps: { billMs: 30 } }); w.orderGate = defer(); await w.img(); await w.txt("shop nhận được chưa ạ?");
  assert.equal(w.tickets.length, 1);
  w.orderGate.resolve(); await settle(20); w.ticket = null; w.clock += 60_000; await w.img();
  assert.equal(w.created.length, 1); assert.ok(!has(w, /chuyển khoản lại nhé/));
});
test("F-tải ảnh chậm tải ảnh từ Meta quá giờ: không đơn trùng, báo Admin 1 lần", async () => {
  const w = await world({ deps: { billMs: 30 } }); w.download = defer(); await w.img(); w.download.resolve(); await settle(20);
  assert.ok(w.created.length <= 1); assert.equal(w.tickets.length, 1);
});
test("F-DB lỗi DB lỗi lúc gửi ảnh → 'e gửi' → DB hồi → gửi lại ảnh: 1 đơn", async () => {
  const w = await world(); w.dbDown = true; await w.img(); await w.txt("e gửi"); w.dbDown = false; await w.img(); normal(w);
});
test("F-ticket mở đang có ticket: ảnh bill rồi 'e gửi' — im, 0 đơn (O9)", async () => {
  const w = await world(); w.ticket = { id: "t0", status: "open" }; await w.img(); await w.txt("e gửi");
  assert.equal(w.created.length, 0); assert.deepEqual(w.sent, []);
});
test("F-3 chữ lạ rồi ảnh: 1 nhắc, không ticket, ảnh vẫn tạo đơn", async () => {
  const w = await world(); await w.txt("a"); await w.txt("b"); await w.txt("c"); await w.img(); await w.txt("e gửi");
  assert.equal(w.created.length, 1); assert.equal(w.tickets.length, 0);
});

// ---- AI on: after an order the 30-minute orders view runs before the AI ----
for (const route of ["clarify", "ticket", "offer_admin", "bot_answer", null]) {
  test(`AI-bật (${route ?? "lỗi/timeout"}) đã có đơn → 'e gửi': T7, AI không được gọi, không ticket`, async () => {
    let calls = 0;
    const w = await world({ env: { MESSENGER_AI_ENABLED: "1", AI: { run() {} } }, deps: { runAi: async () => { calls++; return route ? { route, intent: "other", course_slug: null, answer: route === "bot_answer" ? "Dạ shop đã ghi nhận ạ." : null, sources: [] } : null; } } });
    await w.img(); w.sent.length = 0; await w.txt("e gửi");
    assert.equal(calls, 0); assert.equal(w.tickets.length, 0); assert.ok(w.sent.some((m) => T7.test(m)));
  });
}
test("AI-bật B1 AI bật: 'e gửi' → ảnh (AI không được chạy khi có nháp)", async () => {
  const w = await world({ env: { MESSENGER_AI_ENABLED: "1", AI: { run() {} } }, deps: { runAi: async () => { throw new Error("must not run"); } } });
  await w.txt("e gửi"); await w.img(); normal(w);
});
