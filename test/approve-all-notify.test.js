// C1-1: bulk approval tells Facebook buyers like a single approval does, and its dialog reports what did not go through.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { noticeForApproved } from "../utils/messenger/notify.js";

const PSID = "1234567890123";
const ENV = { MESSENGER_BOT_ENABLED: "1", META_PAGE_ACCESS_TOKEN: "t", LMS_PUBLIC_URL: "https://hoc.yeubep.shop" };
const ORDER = { id: "o1", status: "Đã duyệt", course_title: "Khoá TEST", customer_email: "a@gmail.com", raw_data: { channel: "facebook", psid: PSID, billName: "b" } };
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

function fakeDb({ rows = [{ id: "o1" }], throws = false } = {}) {
  const writes = [];
  const db = { from: () => ({ update: (patch) => { writes.push(patch); const chain = { eq: () => chain, select: () => chain, then: (res, rej) => (throws ? Promise.reject(new Error("db")) : Promise.resolve({ error: null, data: rows })).then(res, rej) }; return chain; } }) };
  return { db, writes };
}
function meta(status, body) {
  const calls = [];
  return { calls, impl: async (...args) => { calls.push(args); return new Response(JSON.stringify(body), { status }); } };
}

test("BULK-1 a Facebook order is messaged exactly once and the notice is stored on the order", async () => {
  const { db, writes } = fakeDb();
  const f = meta(200, { recipient_id: PSID, message_id: "m_1" });
  const out = await noticeForApproved(db, ORDER, { env: ENV, fetchImpl: f.impl });
  assert.equal(f.calls.length, 1);
  assert.equal(out.notice.status, "sent");
  assert.equal(out.saved, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0]), ["raw_data"], "the notice never writes the order status");
  assert.equal(writes[0].raw_data.messengerNotify.status, "sent");
  assert.ok(writes[0].raw_data.messengerNotify.approvedAt);
  assert.equal(writes[0].raw_data.billName, "b");
});

test("BULK-2 a Meta failure or a thrown error becomes a warning, never an exception", async () => {
  const failed = await noticeForApproved(fakeDb().db, ORDER, { env: ENV, fetchImpl: meta(400, { error: { code: 10, error_subcode: 2018278 } }).impl });
  assert.deepEqual([failed.notice.status, failed.notice.reason, failed.saved], ["failed", "window", true]);
  const boom = await noticeForApproved(fakeDb().db, ORDER, { env: ENV, fetchImpl: async () => { throw new Error("x"); }, now: () => { throw new Error("clock"); } });
  assert.deepEqual(boom, { notice: { status: "unknown", reason: "internal" }, saved: false });
  const unsaved = await noticeForApproved(fakeDb({ throws: true }).db, ORDER, { env: ENV, fetchImpl: meta(200, { message_id: "m" }).impl });
  assert.deepEqual([unsaved.notice.status, unsaved.saved], ["sent", false]);
});

test("BULK-3 an order that is not from Facebook sends nothing and writes nothing", async () => {
  const { db, writes } = fakeDb();
  const f = meta(200, { message_id: "m" });
  const out = await noticeForApproved(db, { ...ORDER, raw_data: { channel: "web" } }, { env: ENV, fetchImpl: f.impl });
  assert.deepEqual(out, { notice: null, saved: null });
  assert.equal(f.calls.length + writes.length, 0);
});

test("BULK-4 approve-all.js: the notice runs after a successful V5 approval, on the full approved row, and cannot change `ok`", () => {
  const src = read("api/approve-all.js");
  assert.match(src, /if \(!result\.ok\) \{[\s\S]{0,400}continue;\s*\}\s*approvedOrders\.push\(result\.data\);[\s\S]{0,200}await noticeForApproved\(supabase, \{ \.\.\.order, \.\.\.result\.data \}\);/);
  assert.match(src, /ok: !v5SyncFailed\(result\.syncResults\), sync \}/);
  assert.equal(src.match(/noticeForApproved\(/g).length, 1, "legacy and V4 orders are not notified");
  for (const key of ["messengerNotified", "messengerNeedsHand", "messengerNoticeUnsaved"]) assert.match(src, new RegExp(`\\n\\s+${key},`));
});

test("BULK-5 orders.html: both bulk dialogs report kept-pending, sync errors and un-notified Facebook orders", () => {
  const html = read("orders.html");
  assert.equal(html.match(/alert\(bulkApproveSummary\(data\)\)/g).length, 2);
  assert.doesNotMatch(html, /Đã duyệt hàng loạt \$\{data\.count\} học viên thành công/);
  const fn = html.match(/function bulkApproveSummary\(data\) \{[\s\S]*?\n    \}/)[0];
  const summary = new Function(`${fn}; return bulkApproveSummary;`)();
  assert.equal(summary({ count: 2, copied: true }), "Đã duyệt 2 học viên.\nDanh sách email đã được copy vào clipboard.");
  assert.equal(summary({ count: 2, gmails: ["a"], copied: false }), "Đã duyệt 2 học viên.", "no copy claim when the clipboard refused");
  assert.match(summary({ count: 6, remaining: 3, error: "x" }), /Còn 3 đơn chưa xử lý[\s\S]*Dừng giữa chừng: x/);
  const text = summary({ count: 3, gmails: ["a"], v5KeptPending: 2, syncFailed: 3, messengerNeedsHand: 1, messengerNoticeUnsaved: 1 });
  assert.match(text, /2 đơn vẫn ở "Chờ duyệt"/);
  assert.match(text, /1 đơn đã duyệt nhưng đồng bộ quyền học lỗi/);
  assert.match(text, /1 đơn Facebook chưa báo được cho khách/);
  assert.match(text, /1 đơn Facebook không lưu được kết quả thông báo/);
  assert.equal(summary({ count: 0, v5KeptPending: 1, syncFailed: 1 }).split("\n").length, 2);
});

// C1-1-cap. The fake server follows approve-all.js: skip ids already tried, at most `limit` V5 orders per call,
// legacy orders only once no V5 order is left.
function fakeServer(orders, { limit = 6, failAt = 0 } = {}) {
  const calls = [];
  const post = async ({ course, skip }) => {
    calls.push({ course, skip: [...skip] });
    if (failAt && calls.length === failAt) return { ok: false, data: { error: "boom" } };
    const todo = orders.filter((o) => o.status === "pending" && !skip.includes(o.id));
    const v5 = todo.filter((o) => o.v5).slice(0, limit);
    const batch = v5.length ? v5 : todo.filter((o) => !o.v5);
    const results = batch.map((o) => { if (!o.stuck) o.status = "approved"; return { id: o.id, ok: !o.stuck, keptPending: Boolean(o.stuck) }; });
    const approved = batch.filter((o) => !o.stuck);
    return { ok: true, data: { count: approved.length, gmails: approved.map((o) => o.id + "@gmail.com"), v5KeptPending: batch.length - approved.length, syncFailed: batch.length - approved.length, messengerNeedsHand: approved.filter((o) => o.fb).length, remaining: todo.length - batch.length, results } };
  };
  return { calls, post };
}
function pageRun(clipboard) {
  const html = read("orders.html");
  const fn = html.match(/async function bulkApproveRun\([\s\S]*?\n    \}/)[0];
  return new Function("navigator", "bulkApprovePost", `${fn}; return bulkApproveRun;`)({ clipboard }, null);
}

test("BULK-6 one click drains a large class in requests of at most 6 V5 orders and never retries a stuck order", async () => {
  const orders = Array.from({ length: 14 }, (_, i) => ({ id: "v" + i, v5: true, status: "pending", fb: i < 3, stuck: i === 1 }));
  orders.push({ id: "legacy", v5: false, status: "pending" });
  const server = fakeServer(orders);
  const copied = [];
  const total = await pageRun({ writeText: async (text) => copied.push(text) })("khoa", server.post);
  assert.deepEqual(server.calls.map((c) => c.skip.length), [0, 6, 12, 14]);
  assert.equal(server.calls.filter((c) => c.skip.includes("v1")).length, 3, "the stuck order is skipped in every later request");
  assert.deepEqual([total.count, total.v5KeptPending, total.syncFailed, total.messengerNeedsHand, total.remaining, total.error], [14, 1, 1, 2, 0, ""]);
  assert.equal(copied.length, 1);
  assert.equal(copied[0].split("\n").length, 14);
  assert.equal(total.copied, true);
});

test("BULK-7 a failed request stops the run but keeps what was already approved; a refused clipboard is not claimed", async () => {
  const orders = Array.from({ length: 10 }, (_, i) => ({ id: "v" + i, v5: true, status: "pending" }));
  const server = fakeServer(orders, { failAt: 2 });
  const total = await pageRun({ writeText: async () => { throw new Error("denied"); } })("khoa", server.post);
  assert.deepEqual([total.count, total.remaining, total.error, total.copied], [6, 4, "boom", false]);
  const offline = await pageRun({ writeText: async () => {} })("khoa", async () => { throw new TypeError("fetch failed"); });
  assert.deepEqual([offline.count, offline.error], [0, "Lỗi kết nối"]);
});

test("BULK-8 approve-all.js: at most 6 V5 orders per request, legacy orders wait, `remaining` is reported", () => {
  const src = read("api/approve-all.js");
  assert.match(src, /const V5_BATCH_LIMIT = 6;/);
  assert.match(src, /const v5Orders = todo\.filter\([^\n]*=== 'v5'\)\.slice\(0, V5_BATCH_LIMIT\);/);
  assert.match(src, /const standardOrders = v5Orders\.length \? \[\] : todo\.filter\(/);
  assert.match(src, /const todo = enrollmentOrders\.filter\(order => !skip\.has\(String\(order\.id\)\)\);/);
  assert.match(src, /const remaining = todo\.length - v5Orders\.length - standardOrders\.length;/);
  assert.match(src, /requested: enrollmentOrders\.length,\s*remaining,/);
  const html = read("orders.html");
  assert.equal(html.match(/await bulkApproveRun\((courseSlug|selectedCourse)\);/g).length, 2);
  assert.equal(html.match(/fetch\("\/api\/approve-all"/g).length, 1, "only bulkApprovePost calls the API");
});
