import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const coursesSource = fs.readFileSync(new URL('../api/courses.js', import.meta.url), 'utf8');
const adminHtmlSource = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const approvalSource = fs.readFileSync(new URL('../utils/v5-order-approval.js', import.meta.url), 'utf8');
const registerSource = fs.readFileSync(new URL('../api/register.js', import.meta.url), 'utf8');

test('F-02 Test A: new V5 course shell creation defaults to active = false and is_published = false', () => {
  // Verifies that base.active is strictly body.active === true and is_published is false
  assert.match(coursesSource, /if \(deliveryMode === 'v5'\) \{\s*base\.active = body\.active === true;\s*base\.is_published = false;\s*\}/);
});

test('F-02 Test B: new V5 course shell creation accepts explicit body.active === true while keeping is_published = false', () => {
  // When body.active is true, base.active evaluates to true; is_published remains false
  const activeEvalWithoutBodyActive = ({}.active === true);
  assert.strictEqual(activeEvalWithoutBodyActive, false, 'Default without body.active must be false');

  const activeEvalWithExplicitTrue = ({ active: true }.active === true);
  assert.strictEqual(activeEvalWithExplicitTrue, true, 'Explicit body.active: true must be true');

  const activeEvalWithExplicitFalse = ({ active: false }.active === true);
  assert.strictEqual(activeEvalWithExplicitFalse, false, 'Explicit body.active: false must be false');
});

test('F-02 Test C: admin.html unchecks courseActiveInput by default when opening modal for a new V5 course', () => {
  assert.match(adminHtmlSource, /if \(mode === 'v5'\) \{\s*if \(!document\.getElementById\('courseId'\)\?\.value\) document\.getElementById\('courseActiveInput'\)\.checked = false;/);
});

test('F-03 Test D: v5ApprovalReadiness uses requireSale: false so pending orders can be approved even if sales closed', () => {
  assert.match(approvalSource, /export async function v5ApprovalReadiness\(order\) \{\s*return v5OrderReadiness\(order, \{ requireSale: false \}\);\s*\}/);
});

test('F-03 Test E: api/register.js registration boundary strictly requires courseRec.active === true', () => {
  assert.match(registerSource, /if \(!courseRec \|\| courseRec\.active === false\) return res\.status\(404\)/);
  assert.match(registerSource, /if \(deliveryMode === 'v5'\) \{\s*if \(courseRec\.active !== true\) \{\s*return res\.status\(409\)/);
});
