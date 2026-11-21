// Website checkout refuses a second open order of the same Gmail + course (Owner 19/11 "Sửa đơn trùng trước").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { findOpenOrder } from '../utils/bill-order.js';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function fakeDb(rows, error = null) {
  const calls = [];
  const q = {
    select(cols) { calls.push(['select', cols]); return q; },
    eq(k, v) { calls.push(['eq', k, v]); return q; },
    in(k, v) { calls.push(['in', k, v]); return q; },
    limit(n) { calls.push(['limit', n]); return Promise.resolve({ data: rows, error }); }
  };
  return { calls, from(t) { calls.push(['from', t]); return q; } };
}

test('WD-1 finds a waiting or approved order of this Gmail for this course only', async () => {
  const db = fakeDb([{ id: 'o1', status: 'Chờ duyệt' }]);
  assert.deepEqual(await findOpenOrder(db, 'a@gmail.com', 'khoa-a'), { id: 'o1', status: 'Chờ duyệt' });
  assert.deepEqual(db.calls, [
    ['from', 'orders'], ['select', 'id,status'], ['eq', 'customer_email', 'a@gmail.com'], ['eq', 'course_slug', 'khoa-a'],
    ['in', 'status', ['Chờ duyệt', 'Đã duyệt']], ['limit', 1]
  ]); // a rejected order does not block a new one
  assert.equal(await findOpenOrder(fakeDb([]), 'a@gmail.com', 'khoa-a'), null);
});

test('WD-2 a lookup error is thrown (checkout fails closed, no order without the check)', async () => {
  await assert.rejects(findOpenOrder(fakeDb(null, new Error('db')), 'a@gmail.com', 'k'), /db/);
});

test('WD-3 wiring: only the website opts in; the check runs before the bill upload; Admin manual create keeps its own check', () => {
  assert.match(read('api/register.js'), /createBillOrder\(req\.body, \{ rejectDuplicate: true \}\)/);
  const bill = read('utils/bill-order.js');
  const check = bill.indexOf('findOpenOrder(supabase, cleanEmail, courseSlug)');
  assert.ok(check > 0 && check < bill.indexOf('cloudinary.uploader.upload('));
  assert.match(bill, /code: 'duplicate' \}\);/); // same message for waiting and approved, no status field
  assert.match(read('api/orders.js'), /error: 'duplicate'/);
});
