import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { isCourseForSale, isSalePaused } from '../utils/sale-state.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('sale pause is independent from active and publish state', () => {
  const course = { active: true, is_published: true, raw_data: { salePaused: true } };
  assert.equal(isSalePaused(course), true);
  assert.equal(isCourseForSale(course), false);
  assert.equal(course.active, true);
  assert.equal(course.is_published, true);
});

test('only an explicit boolean true pauses sales', () => {
  assert.equal(isSalePaused({ raw_data: { salePaused: 'true' } }), false);
  assert.equal(isSalePaused({ raw_data: {} }), false);
  assert.equal(isSalePaused(null), false);
});

test('all public sale entry points enforce the independent pause flag', () => {
  assert.match(read('api/config.js'), /if \(isSalePaused\(course\)\)/);
  assert.match(read('api/hero.js'), /isSalePaused\(course\)/);
  assert.match(read('api/register.js'), /if \(isSalePaused\(courseRec\)\)/);
  assert.match(read('api/register.js'), /code: 'sale_paused'/);
});

test('admin course updates validate and merge the pause flag into raw_data', () => {
  const source = read('api/courses.js');
  assert.match(source, /typeof body\.salePaused !== 'boolean'/);
  assert.match(source, /rawDataPatch\.salePaused = body\.salePaused/);
  assert.match(source, /base\.raw_data = \{ \.\.\.\(existing\.raw_data \|\| \{\}\), \.\.\.base\.raw_data \}/);
});

test('admin distinguishes sale pause from the system active switch', () => {
  const admin = read('admin.html');
  assert.match(admin, /const salePaused = course\.salePaused === true/);
  assert.match(admin, /Bán: \$\{selling \? 'Đang bán' : salePaused \? 'Tạm dừng'/);
  assert.match(admin, /toggleCourseSalePause/);
  assert.match(admin, /Quyền học và trạng thái Publish sẽ được giữ nguyên/);
  assert.match(admin, /salePaused: nextPaused/);
});
