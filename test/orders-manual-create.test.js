// B1: Admin "Tạo đơn thủ công" (POST /api/orders action manual_create).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ordersHandler from "../api/orders.js";
import { notifyApprovedOrder } from "../utils/messenger/notify.js";

const PW = "pw-b1";
const BODY = { action: "manual_create", course: "Khoa-A", gmail: " Hoc.Vien@Gmail.com ", billType: "image/png", billData: "AAAA", billName: "b.png", source: "page_inbox", note: "khach nhan Page" };

function setup({ dupRows = [], created = { status: 200, body: { success: true, orderId: "o1" } } } = {}) {
  const calls = { create: [], dup: [] };
  const q = { eqs: [] };
  const chain = { select: () => chain, eq: (k, v) => { q.eqs.push([k, v]); return chain; }, in: (k, v) => { q.in = [k, v]; return chain; }, limit: async () => { calls.dup.push(q); return { data: dupRows, error: null }; } };
  const supabaseClient = { rpc: async () => ({ data: [], error: null }), from: (t) => { assert.equal(t, "orders"); return chain; } };
  const createBillOrder = async (...args) => { calls.create.push(args); return created; };
  return { calls, q, options: { supabaseClient, createBillOrder } };
}

async function post({ password = PW, body = BODY, options }) {
  process.env.ADMIN_PASSWORD = PW;
  process.env.LEGACY_HOST_ALLOWLIST = "legacy.example.test";
  const req = { method: "POST", headers: { host: "legacy.example.test", ...(password === null ? {} : { "x-admin-password": password }) }, body, query: {}, __options: options };
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(d) { this.body = d; return this; }, end() { return this; } };
  try { await ordersHandler(req, res); } finally { delete process.env.ADMIN_PASSWORD; delete process.env.LEGACY_HOST_ALLOWLIST; }
  return res;
}

test("MC-1 needs the Admin password", async () => {
  const s = setup();
  for (const password of [null, "wrong"]) assert.equal((await post({ password, options: s.options })).statusCode, 401);
  assert.equal(s.calls.create.length, 0);
});

test("MC-2 bad gmail, source, note or course -> 400, nothing created", async () => {
  const s = setup();
  for (const patch of [{ gmail: "a@b" }, { gmail: "ké@gmail.com" }, { source: "facebook" }, { source: undefined }, { note: "x".repeat(201) }, { course: "a b!" }, { action: "x" }]) {
    assert.equal((await post({ body: { ...BODY, ...patch }, options: s.options })).statusCode, 400, JSON.stringify(patch));
  }
  assert.equal(s.calls.create.length, 0);
});

test("MC-3 duplicate pending/approved order -> 409, createBillOrder not called", async () => {
  const s = setup({ dupRows: [{ id: "old", status: "Chờ duyệt" }] });
  const res = await post({ options: s.options });
  assert.equal(res.statusCode, 409);
  assert.deepEqual([res.body.error, res.body.status], ["duplicate", "Chờ duyệt"]);
  assert.equal(s.calls.create.length, 0);
  assert.deepEqual(s.q.in, ["status", ["Chờ duyệt", "Đã duyệt"]]);
  assert.deepEqual(s.q.eqs, [["customer_email", "hoc.vien@gmail.com"], ["course_slug", "khoa-a"]]);
});

test("MC-4 success calls createBillOrder with channel manual, source and note", async () => {
  const s = setup();
  const res = await post({ options: s.options });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.orderId, "o1");
  const [input, { rawExtra }] = s.calls.create[0];
  assert.deepEqual(rawExtra, { channel: "manual", source: "page_inbox", manualNote: "khach nhan Page", createdBy: "admin" });
  assert.deepEqual([input.gmail, input.course, input.billType, input.billData], ["hoc.vien@gmail.com", "khoa-a", "image/png", "AAAA"]);
});

test("MC-5 createBillOrder 404/409 are passed through; billName defaults to manual-<time>", async () => {
  for (const created of [{ status: 404, body: { error: "Khóa học không tồn tại hoặc chưa mở đăng ký" } }, { status: 409, body: { error: "x", code: "sale_paused" } }]) {
    const s = setup({ created });
    const res = await post({ body: { ...BODY, billName: undefined }, options: s.options });
    assert.deepEqual([res.statusCode, res.body], [created.status, created.body]);
    assert.match(s.calls.create[0][0].billName, /^manual-\d+$/);
  }
});

test("MC-6 approving a manual order sends no Messenger message (notify gives null)", async () => {
  let fetched = 0;
  const order = { id: "o1", status: "Đã duyệt", customer_email: "a@gmail.com", raw_data: { channel: "manual", source: "other", psid: "1234567890123" } };
  const notice = await notifyApprovedOrder(order, { env: { MESSENGER_BOT_ENABLED: "1", META_PAGE_ACCESS_TOKEN: "t" }, fetchImpl: async () => { fetched++; return new Response("{}"); } });
  assert.equal(notice, null);
  assert.equal(fetched, 0);
});

test("MC-7 orders.html: manual label, reminder and no innerHTML in the manual block", () => {
  const html = readFileSync(new URL("../orders.html", import.meta.url), "utf8");
  assert.match(html, /Tạo đơn thủ công/);
  assert.match(html, /order\.channel === 'manual'/);
  assert.match(html, /order\.manualNote/);
  assert.match(html, /dưới 3,3 MB/);
  assert.match(html, /deliveryMode !== "telegram" && x\.salePaused !== true/);
  assert.match(html, /trả lời mẫu \/vaohoc/);
  const block = html.slice(html.indexOf("// B1: manual order."), html.indexOf("async function loadOrders()"));
  assert.ok(block.length > 100 && !/innerHTML|outerHTML|insertAdjacentHTML/.test(block) && !/`[^`]*\$\{/.test(block));
});
