// G2: the approval notice is classified from Meta's real answer, stored on the order and handled by hand without touching the order.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifySend, notifyApprovedOrder, saveApprovalNotice, markNoticeManual } from "../utils/messenger/notify.js";
import { sendMessage } from "../utils/messenger/meta.js";

const PSID = "1234567890123";
const ENV = { MESSENGER_BOT_ENABLED: "1", META_PAGE_ACCESS_TOKEN: "page-token-SECRET", LMS_PUBLIC_URL: "https://hoc.yeubep.shop" };
const ORDER = { id: "o1", status: "Đã duyệt", course_title: "Khoá TEST", customer_email: "a@gmail.com", raw_data: { channel: "facebook", psid: PSID, billName: "b" } };
const meta = (status, body) => async () => new Response(JSON.stringify(body), { status });
const notify = (fetchImpl, env = ENV) => notifyApprovedOrder(ORDER, { env, fetchImpl, now: () => new Date("2026-11-11T09:00:00Z") });

function fakeDb({ error = null, throws = false, rows = [{ id: "o1" }] } = {}) {
  const writes = [];
  const q = { filters: [] };
  const db = { from: (table) => ({ update: (patch) => { const w = { table, patch, filters: [] }; writes.push(w); const chain = { eq: (k, v) => { w.filters.push([k, v]); return chain; }, select: () => chain, then: (res, rej) => (throws ? Promise.reject(new Error("db")) : Promise.resolve({ error, data: error ? null : rows })).then(res, rej) }; return chain; } }) };
  return { db, writes, q };
}

test("NOTIFY-1 sent only with Meta's message_id", async () => {
  const n = await notify(meta(200, { recipient_id: PSID, message_id: "m_abc" }));
  assert.deepEqual(n, { status: "sent", reason: null, attemptedAt: "2026-11-11T09:00:00.000Z" });
  assert.deepEqual(await sendMessage(PSID, { text: "x" }, { token: "t", fetchImpl: meta(200, { message_id: "m_1" }) }), { ok: true, messageId: "m_1" });
});

test("NOTIFY-2 a 2xx without message_id is not reported as sent", async () => {
  assert.deepEqual((await notify(meta(200, {}))).status, "unknown");
  assert.equal((await notify(meta(200, {}))).reason, "no_message_id");
});

test("NOTIFY-3 outside the 24-hour window: failed / window, with Meta's numbers only", async () => {
  const n = await notify(meta(400, { error: { code: 10, error_subcode: 2018278, message: "This message is sent outside of allowed window. token page-token-SECRET" } }));
  assert.deepEqual({ ...n, attemptedAt: undefined }, { status: "failed", reason: "window", metaCode: 10, metaSubcode: 2018278, attemptedAt: undefined });
  assert.ok(!JSON.stringify(n).includes("allowed window") && !JSON.stringify(n).includes("SECRET"));
});

test("NOTIFY-4 code 10 without the window subcode is not called a window error", async () => {
  assert.equal((await notify(meta(400, { error: { code: 10, error_subcode: 1 } }))).reason, "api_other");
});

test("NOTIFY-5 551, 190, 4 and 613 map to their own reasons", async () => {
  assert.equal((await notify(meta(400, { error: { code: 551, error_subcode: 1545041 } }))).reason, "user_unavailable");
  assert.equal((await notify(meta(400, { error: { code: 190, error_subcode: 460 } }))).reason, "page_config");
  assert.equal((await notify(meta(400, { error: { code: 613 } }))).reason, "rate_limit");
  assert.equal((await notify(meta(400, { error: { code: 4 } }))).reason, "rate_limit");
  assert.equal((await notify(meta(400, { error: { code: 2 } }))).reason, "api_other");
  // Meta server errors may have delivered the message.
  assert.deepEqual([(await notify(meta(500, { error: { code: 2 } }))).status, (await notify(meta(502, "bad gateway"))).reason], ["unknown", "meta_error"]);
});

test("NOTIFY-6 timeout and network errors are unknown, never failed", async () => {
  const timeout = async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };
  const net = async () => { throw new TypeError("fetch failed"); };
  assert.deepEqual([(await notify(timeout)).status, (await notify(timeout)).reason], ["unknown", "timeout"]);
  assert.deepEqual([(await notify(net)).status, (await notify(net)).reason], ["unknown", "network"]);
});

test("NOTIFY-7 missing page token is a configuration failure; bot off is 'skipped'; non-Facebook orders give nothing", async () => {
  assert.equal((await notify(meta(200, {}), { ...ENV, META_PAGE_ACCESS_TOKEN: "" })).reason, "page_config");
  assert.deepEqual(await notify(meta(200, {}), { ...ENV, MESSENGER_BOT_ENABLED: "0" }), { status: "skipped", reason: "bot_off", attemptedAt: "2026-11-11T09:00:00.000Z" });
  assert.equal(await notifyApprovedOrder({ raw_data: { channel: "web" } }, { env: ENV }), null);
  assert.equal(classifySend(undefined).status, "failed");
});

test("NOTIFY-8 saving keeps the other raw_data fields, replaces an old manual mark, and only writes raw_data of an approved order", async () => {
  const { db, writes } = fakeDb();
  const order = { ...ORDER, raw_data: { ...ORDER.raw_data, messengerNotify: { status: "failed", manual: { at: "x", note: "cũ" } } } };
  assert.equal(await saveApprovalNotice(db, order, { status: "failed", reason: "window" }), true);
  assert.deepEqual(Object.keys(writes[0].patch), ["raw_data"]);
  assert.equal(writes[0].patch.raw_data.billName, "b");
  assert.deepEqual(writes[0].patch.raw_data.messengerNotify, { status: "failed", reason: "window" });
  assert.deepEqual(writes[0].filters, [["id", "o1"], ["status", "Đã duyệt"]]);
});

test("NOTIFY-9 a save error or throw returns false, never throws", async () => {
  assert.equal(await saveApprovalNotice(fakeDb({ error: { message: "x" } }).db, ORDER, { status: "failed" }), false);
  assert.equal(await saveApprovalNotice(fakeDb({ throws: true }).db, ORDER, { status: "failed" }), false);
});

test("NOTIFY-10 manual mark writes only raw_data.messengerNotify.manual (status, payment and access untouched)", async () => {
  const { db, writes } = fakeDb();
  const order = { ...ORDER, sync_lms_status: "SUCCESS", raw_data: { ...ORDER.raw_data, messengerNotify: { status: "failed", reason: "window" } } };
  const r = await markNoticeManual(db, order, "  Đã nhắn\\n  qua Hộp thư  ");
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(writes[0].patch), ["raw_data"]);
  const n = writes[0].patch.raw_data.messengerNotify;
  assert.equal(n.status, "failed");
  assert.equal(n.reason, "window");
  assert.equal(n.manual.note, "Đã nhắn\\n qua Hộp thư");
  assert.ok(!Number.isNaN(Date.parse(n.manual.at)));
  assert.equal(writes[0].patch.raw_data.billName, "b");
  assert.deepEqual(writes[0].filters, [["id", "o1"], ["status", "Đã duyệt"]]);
});

test("NOTIFY-11 manual mark: refused when not needed, no duplicate write, long note cut", async () => {
  for (const order of [{ ...ORDER, status: "Chờ duyệt", raw_data: { messengerNotify: { status: "failed" } } }, { ...ORDER, raw_data: { messengerNotify: { status: "sent" } } }, ORDER]) {
    const { db, writes } = fakeDb();
    assert.equal((await markNoticeManual(db, order, "x")).status, 409);
    assert.equal(writes.length, 0);
  }
  const done = fakeDb();
  const already = { ...ORDER, raw_data: { messengerNotify: { status: "failed", manual: { at: "t", note: "n" } } } };
  assert.equal((await markNoticeManual(done.db, already, "lại")).ok, true);
  assert.equal(done.writes.length, 0, "no second write");
  const long = fakeDb();
  await markNoticeManual(long.db, { ...ORDER, raw_data: { messengerNotify: { status: "unknown" } } }, "a".repeat(500));
  assert.equal(long.writes[0].patch.raw_data.messengerNotify.manual.note.length, 200);
  const failing = fakeDb({ error: { message: "db" } });
  assert.equal((await markNoticeManual(failing.db, { ...ORDER, raw_data: { messengerNotify: { status: "unknown" } } }, "")).status, 500);
});

test("NOTIFY-12 orders API: the manual action returns before any status or sync logic; approval wraps the notice", () => {
  const src = readFileSync(new URL("../api/orders.js", import.meta.url), "utf8");
  const manual = src.indexOf("action === 'messenger_notify_manual'");
  assert.ok(manual > 0 && manual < src.indexOf("const deliveryMode = String(existingOrder.delivery_mode"));
  assert.match(src, /try \{\s*notice = await notifyApprovedOrder\(approved\);\s*if \(notice\) noticeSaved = await saveApprovalNotice\(supabase, approved/);
  assert.match(src, /\.\.\.\(o\.raw_data \|\| \{\}\)/, "GET returns raw_data, so the warning survives a reload");
});

test("NOTIFY-13 orders.html: warning list built with textContent, fixed texts, the Owner's window sentence", () => {
  const html = readFileSync(new URL("../orders.html", import.meta.url), "utf8");
  const body = html.slice(html.indexOf("function renderNotify()"), html.indexOf("async function markNotifyManual"));
  assert.ok(body.length > 100);
  assert.ok(!/innerHTML/.test(body));
  assert.match(html, /window: "Đơn đã duyệt nhưng chưa gửi được thông báo Messenger\. Admin cần liên hệ khách thủ công\."/);
  assert.match(html, /action: "messenger_notify_manual"/);
  assert.match(html, /renderOrders\(\);\s*renderNotify\(\);/);
});

test("NOTIFY-14 orders.html: only approved orders with a non-sent notice are listed; handled ones stay visible but are not counted", () => {
  const html = readFileSync(new URL("../orders.html", import.meta.url), "utf8");
  const fn = /const notifyNeedsHand = ([^;]+);/.exec(html)[1];
  const needs = new Function(`return ${fn}`)();
  assert.equal(needs({ status: "Đã duyệt", messengerNotify: { status: "failed" } }), true);
  assert.equal(needs({ status: "Đã duyệt", messengerNotify: { status: "unknown" } }), true);
  assert.equal(needs({ status: "Đã duyệt", messengerNotify: { status: "sent" } }), false);
  assert.equal(needs({ status: "Từ chối", messengerNotify: { status: "failed" } }), false, "revoked: no warning");
  assert.ok(!needs({ status: "Đã duyệt" }), "old orders without a notice");
  assert.match(html, /filter\(\(o\) => !o\.messengerNotify\.manual\)\.length/);
});

test("NOTIFY-15 an order revoked meanwhile (0 rows updated): notice not saved, manual mark refused", async () => {
  assert.equal(await saveApprovalNotice(fakeDb({ rows: [] }).db, ORDER, { status: "failed" }), false);
  const r = await markNoticeManual(fakeDb({ rows: [] }).db, { ...ORDER, raw_data: { messengerNotify: { status: "failed" } } }, "x");
  assert.equal(r.status, 409);
});
