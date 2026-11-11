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
  assert.equal(summary({ count: 2, gmails: ["a", "b"] }), "Đã duyệt 2 học viên.\nDanh sách email đã được copy vào clipboard.");
  const text = summary({ count: 3, gmails: ["a"], v5KeptPending: 2, syncFailed: 3, messengerNeedsHand: 1, messengerNoticeUnsaved: 1 });
  assert.match(text, /2 đơn vẫn ở "Chờ duyệt"/);
  assert.match(text, /1 đơn đã duyệt nhưng đồng bộ quyền học lỗi/);
  assert.match(text, /1 đơn Facebook chưa báo được cho khách/);
  assert.match(text, /1 đơn Facebook không lưu được kết quả thông báo/);
  assert.equal(summary({ count: 0, v5KeptPending: 1, syncFailed: 1 }).split("\n").length, 2);
});
