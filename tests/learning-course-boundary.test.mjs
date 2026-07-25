import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  getEffectiveLearningSlug,
  isGrantingOrderStatus,
  normalizeCustomerEmail,
  resolveLearningCourse,
  snapshotOrderLearningSlug,
  validateLearningCourseTarget
} from "../utils/learning-course.js";

const canonical = { id: "canonical", slug: "thitxiennuongchaungoc", active: true, learning_course_slug: null };
const alias = { id: "alias", slug: "thitxiennuongchaungoc-yeubep", active: true, learning_course_slug: canonical.slug };

test("legacy course/order fallback uses own sales slug", () => {
  assert.equal(getEffectiveLearningSlug({ slug: "legacy", learning_course_slug: null }), "legacy");
  assert.equal(getEffectiveLearningSlug({ course_slug: "legacy", learning_course_slug: null }), "legacy");
});

test("alias resolves one level to canonical course with lessons", async () => {
  const result = await resolveLearningCourse(alias, {
    findCourseBySlug: async (slug) => slug === canonical.slug ? canonical : null,
    countLessons: async () => 4
  });
  assert.equal(result.learningSlug, canonical.slug);
  assert.equal(result.lessonCount, 4);
  assert.equal(result.mapped, true);
});

test("missing, inactive and empty targets are rejected", async () => {
  await assert.rejects(() => resolveLearningCourse(alias, { findCourseBySlug: async () => null, countLessons: async () => 4 }), /Không tìm thấy/);
  assert.throws(() => validateLearningCourseTarget(alias, { ...canonical, active: false }, 4), /không hoạt động/);
  assert.throws(() => validateLearningCourseTarget(alias, canonical, 0), /chưa có bài học/);
});

test("alias chain and circular mapping are rejected", () => {
  assert.throws(() => validateLearningCourseTarget(alias, { ...canonical, learning_course_slug: "third" }, 4), /nhiều tầng/);
  assert.throws(() => validateLearningCourseTarget(alias, { ...canonical, learning_course_slug: alias.slug }, 4), /nhiều tầng|vòng lặp/);
});

test("order snapshot remains immutable when course mapping later changes", () => {
  const order = { course_slug: alias.slug, learning_course_slug: snapshotOrderLearningSlug(alias) };
  alias.learning_course_slug = "changed-later";
  assert.equal(getEffectiveLearningSlug(order), canonical.slug);
  alias.learning_course_slug = canonical.slug;
});

test("email normalization and granting status contract are explicit", () => {
  assert.equal(normalizeCustomerEmail("  Student@Example.COM "), "student@example.com");
  assert.equal(isGrantingOrderStatus("Đã duyệt"), true);
  assert.equal(isGrantingOrderStatus("Chờ duyệt"), false);
});

test("sync boundary always uses effective learning slug and skips alias syncCourse", () => {
  const source = fs.readFileSync(new URL("../utils/sync-helpers.js", import.meta.url), "utf8");
  assert.match(source, /getEffectiveLearningSlug\(orderData\)/);
  assert.match(source, /MAPPED_NOT_REQUIRED/);
  assert.doesNotMatch(source, /courseSlug\s*=\s*orderData\.course_slug\s*\|\|/);
});

test("register snapshots server-resolved learning slug and ignores browser override", () => {
  const source = fs.readFileSync(new URL("../api/register.js", import.meta.url), "utf8");
  assert.match(source, /resolveLearningCourseFromSupabase\(courseRec, supabase\)/);
  assert.match(source, /learning_course_slug:\s*learningCourseSlug/);
  assert.doesNotMatch(source, /learning_course_slug\s*=\s*req\.body/);
  assert.match(source, /courseSlug:\s*learningCourseSlug/);
});

test("approve-all selects immutable learning snapshot", () => {
  const source = fs.readFileSync(new URL("../api/approve-all.js", import.meta.url), "utf8");
  assert.match(source, /learning_course_slug/);
  assert.match(source, /applyOrderTenantFilter/);
});

test("revoke checks another granting order by normalized email and learning target", () => {
  const helper = fs.readFileSync(new URL("../utils/learning-course.js", import.meta.url), "utf8");
  const orders = fs.readFileSync(new URL("../api/orders.js", import.meta.url), "utf8");
  assert.match(helper, /candidate\.id !== order\.id/);
  assert.match(helper, /getEffectiveLearningSlug\(candidate\) === learningSlug/);
  assert.match(orders, /SHARED_ENTITLEMENT_RETAINED/);
});

test("fixture alias stores canonical snapshot and dry-run payload", async () => {
  process.env.COMMERCE_DATA_MODE = "fixture";
  process.env.SALES_SITE = "yeubep";
  const fixture = await import(`../utils/preview-fixture.js?learning=${Date.now()}`);
  const result = fixture.fixtureRegister({
    course: alias.slug,
    gmail: "student@example.com"
  }, "fixture-learning-key-0001");
  assert.equal(result.order.course_slug, alias.slug);
  assert.equal(result.order.learning_course_slug, canonical.slug);
  const approved = fixture.fixtureUpdateOrder(result.order.id, { status: "Đã duyệt" });
  assert.deepEqual(approved.dry_run_sync, {
    action: "syncEnrollment",
    email: "student@example.com",
    courseSlug: canonical.slug
  });
});

test("fixture revoke retains shared entitlement until the final granting order", async () => {
  process.env.COMMERCE_DATA_MODE = "fixture";
  process.env.SALES_SITE = "yeubep";
  const fixture = await import(`../utils/preview-fixture.js?shared=${Date.now()}`);
  const aliasOrder = fixture.fixtureRegister({
    course: alias.slug,
    gmail: "Shared@Example.COM"
  }, "fixture-shared-key-0001").order;
  fixture.fixtureUpdateOrder(aliasOrder.id, { status: "Đã duyệt" });
  const canonicalOrder = {
    id: "fixture-canonical-order",
    course_slug: canonical.slug,
    learning_course_slug: canonical.slug,
    customer_email: "shared@example.com",
    status: "Đã duyệt",
    sales_site: "yeunauan"
  };
  fixture.fixtureOrders().push(canonicalOrder);
  const firstRevoke = fixture.fixtureUpdateOrder(aliasOrder.id, { status: "Đã hủy" });
  assert.equal(firstRevoke.dry_run_sync.action, "retainSharedEntitlement");
  const finalRevoke = fixture.fixtureUpdateOrder(canonicalOrder.id, { status: "Đã hủy" });
  assert.deepEqual(finalRevoke.dry_run_sync, {
    action: "revokeEnrollment",
    email: "shared@example.com",
    courseSlug: canonical.slug
  });
});

test("learning migration is idempotent, preserves legacy NULL and rolls back", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE courses (id uuid primary key, slug text unique, sales_site text);
    CREATE TABLE orders (id uuid primary key, course_slug text, customer_email text, status text, sales_site text);
    INSERT INTO courses VALUES ('00000000-0000-0000-0000-000000000001','legacy',NULL);
    INSERT INTO orders VALUES ('00000000-0000-0000-0000-000000000002','legacy','x@example.com','Đã duyệt',NULL);
  `);
  const migration = fs.readFileSync(new URL("../migrations/20260725_learning_course_boundary.sql", import.meta.url), "utf8");
  const rollback = fs.readFileSync(new URL("../migrations/20260725_learning_course_boundary_rollback.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(migration);
  const legacy = await db.query("select learning_course_slug from courses where slug='legacy'");
  assert.equal(legacy.rows[0].learning_course_slug, null);
  const unique = await db.query("select count(*)::int n from pg_constraint where contype='u' and conrelid='courses'::regclass");
  assert.equal(unique.rows[0].n, 1);
  await db.exec(rollback);
  await db.exec(migration);
  const columns = await db.query("select count(*)::int n from information_schema.columns where column_name='learning_course_slug' and table_name in ('courses','orders')");
  assert.equal(columns.rows[0].n, 2);
  await db.close();
});
