// utils/agency-provisioner.js
// System B Milestone M0C — Idempotent Agency Provisioning Package & Lifecycle Engine
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Milestone M0B.1 / Pre-M0C Remediation V2 Hardening
//
// Invariants:
//   1. Strict Idempotency: Running plan/apply repeatedly produces zero duplicates.
//   2. Cross-Tenant Isolation: No accidental overwrite or domain collisions across agencies.
//   3. Domain Collision Before Write (10B): Checked BEFORE creating or mutating any agency row.
//   4. Canonical Immutability (10C): Never overwrites existing canonical_courses.course_id mapping.
//   5. Valid Role Enum (10D): Allowed roles: student, agency_staff, agency_owner. No agency_admin.
//   6. V5 Readiness Deep Verification (10E): Validates release snapshot & canonical lesson mappings.
//   7. Deprovision Safety (Phase 11): Only deletes verified synthetic test fixtures with run ID match.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { supabase as defaultSupabase } from "./supabase.js";

// Protected agency slugs that can NEVER be deprovisioned under any circumstances
const PROTECTED_SLUGS = new Set(["yeunauan", "agency-a"]);
const VALID_MEMBERSHIP_ROLES = new Set(["student", "agency_staff", "agency_owner"]);

/**
 * Asserts that the current target is an isolated test environment and NEVER
 * a protected production project (yyiavtiwtekkocqpephr or aqozjkfwzmyfunqvcyjv).
 */
export function assertTrustedSyntheticTestTarget(_options = {}, client = defaultSupabase) {
  const expectedUrl = String(process.env.PRE_M0C_TEST_SUPABASE_URL || "").trim().replace(/\/$/, "");
  const expectedDbUrl = String(process.env.PRE_M0C_TEST_DATABASE_URL || "").trim();
  const environmentFingerprint = String(process.env.PRE_M0C_TEST_ENVIRONMENT_FINGERPRINT || "").trim();
  const verifiedSystemIdentifier = String(process.env.PRE_M0C_TEST_VERIFIED_SYSTEM_IDENTIFIER || "").trim();
  const targetVerified = process.env.PRE_M0C_TEST_TARGET_VERIFIED === "true";
  const sameStackVerified = process.env.PRE_M0C_TEST_SAME_STACK_VERIFIED === "true";
  const identityFileRaw = String(process.env.PRE_M0C_TEST_DB_IDENTITY_FILE || "").trim();

  const clientUrl = String(client?.supabaseUrl || process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const dbUrl = String(process.env.DATABASE_URL || process.env.LOCAL_TEST_DB_URL || "").trim();

  if (!expectedUrl || !expectedDbUrl || !environmentFingerprint || !verifiedSystemIdentifier || !identityFileRaw || !targetVerified || !sameStackVerified) {
    throw new Error(
      "SECURITY VIOLATION: Synthetic operations require an independently verified PRE_M0C test-target identity context."
    );
  }

  const forbiddenTargets = ["yyiavtiwtekkocqpephr", "aqozjkfwzmyfunqvcyjv"];
  for (const forbidden of forbiddenTargets) {
    if ([clientUrl, dbUrl, expectedUrl, expectedDbUrl].some((value) => value.includes(forbidden))) {
      throw new Error(`SECURITY VIOLATION: Synthetic operations are forbidden against protected project ${forbidden}.`);
    }
  }

  let parsedDb;
  let parsedExpectedSupabase;
  let parsedClient;
  try {
    parsedDb = new URL(expectedDbUrl);
    parsedExpectedSupabase = new URL(expectedUrl);
    parsedClient = new URL(clientUrl);
  } catch {
    throw new Error("SECURITY VIOLATION: Synthetic target URLs are invalid.");
  }

  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!["postgres:", "postgresql:"].includes(parsedDb.protocol) || !loopbackHosts.has(parsedDb.hostname)) {
    throw new Error("SECURITY VIOLATION: Synthetic database target must use an explicit loopback PostgreSQL hostname.");
  }
  if (!loopbackHosts.has(parsedExpectedSupabase.hostname) || !loopbackHosts.has(parsedClient.hostname)) {
    throw new Error("SECURITY VIOLATION: Synthetic Supabase target must use an explicit loopback hostname.");
  }

  const identityFile = path.resolve(identityFileRaw);
  const cwd = path.resolve(process.cwd());
  const relative = path.relative(cwd, identityFile);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("SECURITY VIOLATION: PRE_M0C_TEST_DB_IDENTITY_FILE must live outside the repository working tree.");
  }

  let pinned;
  try {
    pinned = JSON.parse(fs.readFileSync(identityFile, "utf8"));
  } catch (error) {
    throw new Error(`SECURITY VIOLATION: Unable to read pinned test-target identity: ${error.message}`);
  }

  const pinnedSystemIdentifier = String(pinned?.systemIdentifier || "").trim();
  const pinnedDatabaseName = String(pinned?.databaseName || "").trim();
  const pinnedSupabaseUrl = String(pinned?.supabaseUrl || "").trim().replace(/\/$/, "");
  if (pinned?.version !== 1 || !/^\d+$/.test(pinnedSystemIdentifier) || !pinnedDatabaseName || !pinnedSupabaseUrl) {
    throw new Error("SECURITY VIOLATION: Pinned pre-M0C test-target identity file is invalid.");
  }

  if (verifiedSystemIdentifier !== pinnedSystemIdentifier) {
    throw new Error("SECURITY VIOLATION: Verified PostgreSQL system_identifier does not match the pinned isolated-test identity.");
  }
  if (expectedUrl !== pinnedSupabaseUrl || clientUrl !== expectedUrl) {
    throw new Error("SECURITY VIOLATION: Supabase client target does not match the pinned isolated-test identity.");
  }
  if (dbUrl !== expectedDbUrl) {
    throw new Error("SECURITY VIOLATION: Database target does not match PRE_M0C_TEST_DATABASE_URL.");
  }

  const derivedFingerprint = crypto
    .createHash("sha256")
    .update(`${pinnedSystemIdentifier}\n${pinnedDatabaseName}\n${pinnedSupabaseUrl}`)
    .digest("hex");
  if (environmentFingerprint !== derivedFingerprint) {
    throw new Error("SECURITY VIOLATION: Synthetic test-target fingerprint was not produced by the verified pinned identity.");
  }

  return Object.freeze({
    supabaseUrl: expectedUrl,
    databaseUrl: expectedDbUrl,
    systemIdentifier: pinnedSystemIdentifier,
    environmentFingerprint
  });
}

/**
 * Validates manifest structure and ensures no secrets are present.
 * Phase 10A: Strict Manifest Preflight.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Invalid manifest: Manifest must be a non-null object.");
  }

  // 1. Agency Metadata
  if (!manifest.agency || typeof manifest.agency !== "object") {
    throw new Error("Invalid manifest: Missing 'agency' object.");
  }
  const { slug, name, status } = manifest.agency;
  if (!slug || typeof slug !== "string" || !/^[a-z0-9-_]+$/.test(slug)) {
    throw new Error(`Invalid manifest: Agency slug '${slug}' must be lowercase alphanumeric with hyphens or underscores.`);
  }
  if (!name || typeof name !== "string") {
    throw new Error("Invalid manifest: Agency name must be a non-empty string.");
  }
  if (status && !["active", "suspended", "archived"].includes(status)) {
    throw new Error(`Invalid manifest: Unknown agency status '${status}'.`);
  }

  // 2. Domains
  if (!Array.isArray(manifest.domains) || manifest.domains.length === 0) {
    throw new Error("Invalid manifest: 'domains' must be a non-empty array with at least one domain.");
  }
  for (const d of manifest.domains) {
    if (!d.hostname || typeof d.hostname !== "string") {
      throw new Error("Invalid manifest: Domain entry must have a valid 'hostname'.");
    }
  }

  // 3. UI Profiles / Variants (All 6 variants required for M0C readiness)
  if (!manifest.ui || typeof manifest.ui !== "object") {
    throw new Error("Invalid manifest: Missing 'ui' profile configuration.");
  }
  const {
    brand_name,
    storefront_variant,
    checkout_variant,
    admin_variant,
    learner_variant,
    learning_variant,
    homework_variant
  } = manifest.ui;

  if (!brand_name) throw new Error("Invalid manifest: UI profile must have 'brand_name'.");
  if (!storefront_variant) throw new Error("Invalid manifest: UI profile must specify 'storefront_variant'.");
  if (!checkout_variant) throw new Error("Invalid manifest: UI profile must specify 'checkout_variant'.");
  if (!admin_variant) throw new Error("Invalid manifest: UI profile must specify 'admin_variant'.");
  if (!learner_variant) throw new Error("Invalid manifest: UI profile must specify 'learner_variant'.");
  if (!learning_variant) throw new Error("Invalid manifest: UI profile must specify 'learning_variant'.");
  if (!homework_variant) throw new Error("Invalid manifest: UI profile must specify 'homework_variant'.");

  // 4. Bank Accounts (Enforce canonical path: manifest.bank_accounts. Deny manifest.commerce.bank_accounts)
  if (manifest.commerce?.bank_accounts) {
    throw new Error("Invalid manifest: 'manifest.commerce.bank_accounts' is forbidden. Use canonical path 'manifest.bank_accounts'.");
  }
  const bankAccounts = manifest.bank_accounts;
  if (!Array.isArray(bankAccounts) || bankAccounts.length === 0) {
    throw new Error("Invalid manifest: 'bank_accounts' must have at least one active bank routing configuration.");
  }
  for (const b of bankAccounts) {
    if (!b.bank_code || !b.account_number || !b.account_holder) {
      throw new Error("Invalid manifest: Bank accounts must include bank_code, account_number, and account_holder.");
    }
  }

  // 5. Offerings & Items
  if (!Array.isArray(manifest.offerings) || manifest.offerings.length === 0) {
    throw new Error("Invalid manifest: 'offerings' must be a non-empty array.");
  }
  for (const off of manifest.offerings) {
    if (!off.slug || !off.display_title || off.price_vnd === undefined) {
      throw new Error(`Invalid manifest: Offering '${off.slug || "unknown"}' must include slug, display_title, and price_vnd.`);
    }
    if (!Array.isArray(off.items) || off.items.length === 0) {
      throw new Error(`Invalid manifest: Offering '${off.slug}' must include at least one course item.`);
    }
    for (const item of off.items) {
      if (!item?.canonical_course_code || typeof item.canonical_course_code !== "string") {
        throw new Error(
          `Invalid manifest: Offering '${off.slug}' items must use canonical_course_code as the authoritative course identifier.`
        );
      }
    }
  }

  // 6. Learning Courses & Canonical Lessons with v5_lesson_id (Phase 7A & 7C)
  if (!manifest.learning?.courses || !Array.isArray(manifest.learning.courses) || manifest.learning.courses.length === 0) {
    throw new Error("Invalid manifest: 'learning.courses' must be a non-empty array with at least one course.");
  }
  for (const c of manifest.learning.courses) {
    if (!c.code || !c.title) {
      throw new Error("Invalid manifest: Course entries must include 'code' and 'title'.");
    }
    if (!c.course_id) {
      throw new Error(`Invalid manifest: Course '${c.code}' must specify a valid non-null 'course_id'.`);
    }
    if (!Array.isArray(c.lessons) || c.lessons.length === 0) {
      throw new Error(`Invalid manifest: Course '${c.code}' must define at least one canonical lesson.`);
    }
    const hasV5LessonMapping = c.lessons.every(l => l.v5_lesson_id);
    if (!hasV5LessonMapping) {
      throw new Error(`Invalid manifest: All course '${c.code}' lessons must provide valid non-null v5_lesson_id mapping.`);
    }
  }

  // 7. Principals & Membership Roles (Phase 7A & 7B: Mandatory Principals)
  if (!Array.isArray(manifest.principals) || manifest.principals.length === 0) {
    throw new Error("Invalid manifest: 'principals' must be a non-empty array with at least one principal declaration.");
  }
  for (const p of manifest.principals) {
    if (!p.email && !p.user_id) {
      throw new Error("Invalid manifest: Principal declaration must have 'email' or 'user_id'.");
    }
    if (p.role && !VALID_MEMBERSHIP_ROLES.has(p.role)) {
      throw new Error(`Invalid manifest: Role '${p.role}' for principal '${p.email || p.display_name}' is not allowed. Valid roles: ${Array.from(VALID_MEMBERSHIP_ROLES).join(", ")}`);
    }
  }

  // 7. Security scan: prevent secret credentials from entering the manifest
  const serialized = JSON.stringify(manifest);
  const secretPatterns = [
    /service_role/i,
    /sb_secret_[A-Za-z0-9_-]{20,}/i,
    /ey[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+/i, // JWT token
    /ghp_[A-Za-z0-9]{36}/i,
    /-----BEGIN (PRIVATE|RSA) KEY-----/i
  ];
  for (const pattern of secretPatterns) {
    if (pattern.test(serialized)) {
      throw new Error("SECURITY VIOLATION: Manifest contains potential secret or credential token. Manifests must be strictly credential-free.");
    }
  }

  return { ok: true };
}

/**
 * Plan mode: Performs a dry-run comparison between the manifest and current database state.
 * Returns a deterministic list of actions without executing any writes.
 */
export async function planAgencyProvisioning(manifest, options = {}) {
  validateManifest(manifest);
  const client = options.supabaseClient || defaultSupabase;
  const slug = manifest.agency.slug;

  const actions = [];
  const summary = {
    creates: 0,
    updates: 0,
    unchanged: 0,
    conflicts: 0
  };

  // 1. Check agency existence
  const { data: existingAgency, error: agErr } = await client
    .from("agencies")
    .select("id, slug, name, status")
    .eq("slug", slug)
    .maybeSingle();

  if (agErr) throw agErr;

  let agencyId = existingAgency?.id || null;

  if (!existingAgency) {
    actions.push({ entity: "agency", action: "CREATE", details: { slug, name: manifest.agency.name } });
    summary.creates++;
  } else {
    const isNameDifferent = existingAgency.name !== manifest.agency.name;
    const isStatusDifferent = manifest.agency.status && existingAgency.status !== manifest.agency.status;
    if (isNameDifferent || isStatusDifferent) {
      actions.push({ entity: "agency", action: "UPDATE", details: { slug, name: manifest.agency.name } });
      summary.updates++;
    } else {
      actions.push({ entity: "agency", action: "UNCHANGED", details: { slug } });
      summary.unchanged++;
    }
  }

  // 2. 10B Check domains & domain collisions BEFORE any writes
  for (const d of manifest.domains) {
    const { data: existingDomain, error: domErr } = await client
      .from("agency_domains")
      .select("id, agency_id, hostname, is_primary, ssl_status")
      .eq("hostname", d.hostname)
      .maybeSingle();

    if (domErr) throw domErr;

    if (!existingDomain) {
      actions.push({ entity: "domain", action: "CREATE", details: { hostname: d.hostname, is_primary: !!d.is_primary } });
      summary.creates++;
    } else if (agencyId && existingDomain.agency_id !== agencyId) {
      actions.push({
        entity: "domain",
        action: "CONFLICT",
        details: { hostname: d.hostname, conflictWithAgencyId: existingDomain.agency_id }
      });
      summary.conflicts++;
    } else if (!agencyId && existingDomain) {
      // New agency attempting to use domain already owned by another agency
      actions.push({
        entity: "domain",
        action: "CONFLICT",
        details: { hostname: d.hostname, conflictWithAgencyId: existingDomain.agency_id }
      });
      summary.conflicts++;
    } else {
      actions.push({ entity: "domain", action: "UNCHANGED", details: { hostname: d.hostname } });
      summary.unchanged++;
    }
  }

  // 3. Check UI Profile
  if (manifest.ui) {
    if (!existingAgency) {
      actions.push({ entity: "ui_profile", action: "CREATE", details: { brand_name: manifest.ui.brand_name } });
      summary.creates++;
    } else {
      const { data: existingUi } = await client
        .from("agency_ui_profiles")
        .select("agency_id")
        .eq("agency_id", agencyId)
        .maybeSingle();
      if (!existingUi) {
        actions.push({ entity: "ui_profile", action: "CREATE", details: { brand_name: manifest.ui.brand_name } });
        summary.creates++;
      } else {
        actions.push({ entity: "ui_profile", action: "UNCHANGED", details: { brand_name: manifest.ui.brand_name } });
        summary.unchanged++;
      }
    }
  }

  // 4. Check bank accounts (strictly reads manifest.bank_accounts; denies manifest.commerce.bank_accounts)
  if (manifest.commerce?.bank_accounts) {
    throw new Error("Invalid manifest: 'manifest.commerce.bank_accounts' is forbidden. Use canonical path 'manifest.bank_accounts'.");
  }
  const planBankAccounts = manifest.bank_accounts;
  if (planBankAccounts) {
    for (const b of planBankAccounts) {
      if (!existingAgency) {
        actions.push({ entity: "bank_account", action: "CREATE", details: { account_number: b.account_number } });
        summary.creates++;
      } else {
        const { data: exBank } = await client
          .from("agency_bank_accounts")
          .select("id")
          .eq("agency_id", agencyId)
          .eq("account_number", b.account_number)
          .maybeSingle();
        if (!exBank) {
          actions.push({ entity: "bank_account", action: "CREATE", details: { account_number: b.account_number } });
          summary.creates++;
        } else {
          actions.push({ entity: "bank_account", action: "UNCHANGED", details: { account_number: b.account_number } });
          summary.unchanged++;
        }
      }
    }
  }

  // 5. Check offerings
  if (manifest.offerings) {
    for (const o of manifest.offerings) {
      if (!existingAgency) {
        actions.push({ entity: "offering", action: "CREATE", details: { slug: o.slug } });
        summary.creates++;
      } else {
        const { data: exOff } = await client
          .from("agency_offerings")
          .select("id")
          .eq("agency_id", agencyId)
          .eq("slug", o.slug)
          .maybeSingle();
        if (!exOff) {
          actions.push({ entity: "offering", action: "CREATE", details: { slug: o.slug } });
          summary.creates++;
        } else {
          actions.push({ entity: "offering", action: "UNCHANGED", details: { slug: o.slug } });
          summary.unchanged++;
        }
      }
    }
  }

  // 6. 10C Check Canonical Courses Mapping Conflicts
  if (manifest.learning?.courses) {
    for (const c of manifest.learning.courses) {
      const { data: existingCc, error: ccErr } = await client
        .from("canonical_courses")
        .select("id, code, course_id")
        .eq("code", c.code)
        .maybeSingle();

      if (ccErr) throw ccErr;

      if (existingCc && existingCc.course_id && c.course_id && existingCc.course_id !== c.course_id) {
        actions.push({
          entity: "canonical_course",
          action: "CONFLICT",
          details: { code: c.code, existingV5CourseId: existingCc.course_id, manifestV5CourseId: c.course_id }
        });
        summary.conflicts++;
      }
    }
  }

  return {
    ok: summary.conflicts === 0,
    plan: {
      slug,
      agencyExists: !!existingAgency,
      agencyId,
      actions,
      summary
    }
  };
}

/**
 * Phase 4: Complete Preflight Before First Write.
 * Proves agency metadata, domains, UI variants, bank account config, offerings, offering items,
 * principals (real Auth resolution in auth.users), allowed roles, canonical course mapping,
 * and V5 published release snapshot with valid v5_lesson_id.
 * If anything fails or conflicts: throws NOT_READY before ANY database write.
 */
export async function preflightAgencyProvisioning(manifest, options = {}) {
  validateManifest(manifest);
  const client = options.supabaseClient || defaultSupabase;
  const slug = manifest.agency.slug;

  const checks = {
    MANIFEST_VALID: true,
    DOMAINS_COLLISION_FREE: false,
    PRINCIPALS_RESOLVED: false,
    CANONICAL_CONFLICTS_FREE: false,
    V5_COURSES_READINESS: false
  };

  // 1. Domains collision check
  const { data: existingAgency, error: agLookupErr } = await client
    .from("agencies")
    .select("id, slug")
    .eq("slug", slug)
    .maybeSingle();

  if (agLookupErr) throw agLookupErr;
  const agencyId = existingAgency?.id || null;

  for (const d of manifest.domains) {
    const { data: collision, error: colErr } = await client
      .from("agency_domains")
      .select("id, agency_id, hostname")
      .eq("hostname", d.hostname)
      .maybeSingle();

    if (colErr) throw colErr;
    if (collision && collision.agency_id !== agencyId) {
      throw new Error(`NOT_READY: Domain collision detected! Hostname '${d.hostname}' is already registered to agency ID '${collision.agency_id}'.`);
    }
  }
  checks.DOMAINS_COLLISION_FREE = true;

  // 2. Principals real Auth resolution (Must resolve before any writes)
  const { data: usersData, error: listErr } = await client.auth.admin.listUsers();
  if (listErr) {
    throw new Error(`NOT_READY: Failed to query auth.users: ${listErr.message}`);
  }
  const allAuthUsers = usersData?.users || [];

  for (const p of manifest.principals) {
    const targetEmail = p.email ? p.email.toLowerCase().trim() : null;
    const targetId = p.user_id || null;

    let resolved = null;
    if (targetId && targetEmail) {
      resolved = allAuthUsers.find((u) => u.id === targetId);
      if (!resolved) {
        throw new Error(`NOT_READY: Principal with user_id '${targetId}' does not exist in auth.users.`);
      }
      if (resolved.email?.toLowerCase().trim() !== targetEmail) {
        throw new Error(
          `NOT_READY: Principal identity mismatch: user_id '${targetId}' email '${resolved.email}' does not match manifest email '${targetEmail}'.`
        );
      }
    } else if (targetId) {
      resolved = allAuthUsers.find((u) => u.id === targetId);
      if (!resolved) {
        throw new Error(`NOT_READY: Principal with user_id '${targetId}' does not exist in auth.users.`);
      }
    } else if (targetEmail) {
      resolved = allAuthUsers.find((u) => u.email?.toLowerCase().trim() === targetEmail);
      if (!resolved) {
        throw new Error(
          `NOT_READY: Principal '${targetEmail}' does not exist in auth.users. Production preflight requires existing Auth principals.`
        );
      }
    }
  }
  checks.PRINCIPALS_RESOLVED = true;

  // 3. Offering Items Resolution & Canonical Course Checks.
  // canonical_course_code is the authoritative provisioning identifier.
  for (const off of manifest.offerings) {
    for (const item of off.items) {
      const courseCode = String(item.canonical_course_code || "").trim();
      if (!courseCode) {
        throw new Error(`NOT_READY: Offering '${off.slug}' item is missing canonical_course_code.`);
      }

      const manifestCourse = manifest.learning?.courses?.find((course) => course.code === courseCode) || null;
      const { data: dbCourse, error: ccErr } = await client
        .from("canonical_courses")
        .select("id, code, course_id, status")
        .eq("code", courseCode)
        .maybeSingle();

      if (ccErr) throw ccErr;
      if (!manifestCourse && !dbCourse) {
        throw new Error(
          `NOT_READY: Offering '${off.slug}' item '${courseCode}' cannot be resolved to a canonical course.`
        );
      }

      if (item.canonical_course_id) {
        if (!dbCourse || dbCourse.id !== item.canonical_course_id) {
          throw new Error(
            `NOT_READY: Offering '${off.slug}' item identifier conflict: canonical_course_code '${courseCode}' and canonical_course_id '${item.canonical_course_id}' do not identify the same existing canonical course.`
          );
        }
      }

      if (manifestCourse && dbCourse?.course_id && dbCourse.course_id !== manifestCourse.course_id) {
        throw new Error(
          `NOT_READY: Offering item '${courseCode}' conflicts with the existing canonical -> V5 course mapping.`
        );
      }

      // A course referenced only from DB must independently prove current V5 release readiness.
      if (!manifestCourse) {
        if (!dbCourse?.course_id) {
          throw new Error(`NOT_READY: Canonical course '${courseCode}' has no V5 course mapping.`);
        }
        const { data: itemConfig, error: itemCfgErr } = await client
          .from("v5_course_configs")
          .select("course_id, status, published_release_id")
          .eq("course_id", dbCourse.course_id)
          .maybeSingle();
        if (itemCfgErr) throw itemCfgErr;
        if (!itemConfig || itemConfig.status !== "published" || !itemConfig.published_release_id) {
          throw new Error(`NOT_READY: Offering item course '${courseCode}' has no current published V5 release.`);
        }
        const { data: itemRelease, error: itemRelErr } = await client
          .from("v5_releases")
          .select("id, course_id, status")
          .eq("id", itemConfig.published_release_id)
          .eq("course_id", dbCourse.course_id)
          .eq("status", "published")
          .maybeSingle();
        if (itemRelErr) throw itemRelErr;
        if (!itemRelease) {
          throw new Error(`NOT_READY: Offering item course '${courseCode}' published release is missing or invalid.`);
        }
      }
    }
  }

  // 4. Canonical courses conflicts & V5 deep readiness check
  for (const c of manifest.learning.courses) {
    if (!c.course_id) {
      throw new Error(`NOT_READY: Course '${c.code}' course_id cannot be null.`);
    }

    // Check mapping conflict
    const { data: exCc, error: ccErr } = await client
      .from("canonical_courses")
      .select("id, code, course_id")
      .eq("code", c.code)
      .maybeSingle();

    if (ccErr) throw ccErr;
    if (exCc && exCc.course_id && exCc.course_id !== c.course_id) {
      throw new Error(`NOT_READY: Conflicting canonical course mapping for '${c.code}'. Shared canonical curriculum cannot be overwritten.`);
    }

    // Check V5 course config & published release
    const { data: v5Config, error: cfgErr } = await client
      .from("v5_course_configs")
      .select("course_id, status, published_release_id")
      .eq("course_id", c.course_id)
      .maybeSingle();

    if (cfgErr) throw cfgErr;
    if (!v5Config || v5Config.status !== "published" || !v5Config.published_release_id) {
      throw new Error(`NOT_READY: V5 course '${c.course_id}' is not published or has no published release.`);
    }

    const { data: v5Rel, error: relErr } = await client
      .from("v5_releases")
      .select("id, status, snapshot")
      .eq("id", v5Config.published_release_id)
      .eq("status", "published")
      .maybeSingle();

    if (relErr) throw relErr;
    if (!v5Rel || !v5Rel.snapshot) {
      throw new Error(`NOT_READY: V5 published release snapshot not found for course '${c.course_id}'.`);
    }

    const snapshotLessons = v5Rel.snapshot.lessons || [];
    for (const l of c.lessons) {
      if (!l.v5_lesson_id) {
        throw new Error(`NOT_READY: Canonical lesson '${l.title}' has null v5_lesson_id.`);
      }
      const inSnapshot = snapshotLessons.some(sl => sl.id === l.v5_lesson_id);
      if (!inSnapshot) {
        throw new Error(`NOT_READY: Lesson v5_lesson_id '${l.v5_lesson_id}' does not belong to active published release snapshot.`);
      }

      if (exCc?.id) {
        const expectedSort = Number.isInteger(l.sort_order) ? l.sort_order : 1;
        const { data: existingLesson, error: existingLessonErr } = await client
          .from("canonical_lessons")
          .select("id, canonical_course_id, v5_lesson_id, sort_order")
          .eq("canonical_course_id", exCc.id)
          .eq("sort_order", expectedSort)
          .maybeSingle();
        if (existingLessonErr) throw existingLessonErr;
        if (existingLesson?.v5_lesson_id && existingLesson.v5_lesson_id !== l.v5_lesson_id) {
          throw new Error(
            `NOT_READY: Existing canonical lesson mapping conflict for course '${c.code}' sort_order ${expectedSort}; expected '${l.v5_lesson_id}', found '${existingLesson.v5_lesson_id}'.`
          );
        }
      }
    }
  }
  checks.CANONICAL_CONFLICTS_FREE = true;
  checks.V5_COURSES_READINESS = true;

  return { ok: true, slug, checks };
}

/**
 * Phase 5: Atomic Apply.
 * Performs all provisioning database rows through ONE server-side transaction.
 * Serializes same agency manifest provisioning using pg_advisory_xact_lock.
 */
export async function applyAgencyProvisioning(manifest, options = {}) {
  const client = options.supabaseClient || defaultSupabase;
  const slug = manifest.agency.slug;

  // 1. Run Complete Preflight Before First Write
  await preflightAgencyProvisioning(manifest, options);

  // 2. Synthetic Target & Marker Safety Check
  if (options.isSynthetic) {
    assertTrustedSyntheticTestTarget(options, client);
  }

  const { data: existingAgency, error: agLookupErr } = await client
    .from("agencies")
    .select("id, slug")
    .eq("slug", slug)
    .maybeSingle();

  if (agLookupErr) throw agLookupErr;

  if (existingAgency && options.isSynthetic) {
    const { data: fixtureRow, error: fixErr } = await client
      .from("agency_test_fixtures")
      .select("id, run_id")
      .eq("agency_id", existingAgency.id)
      .maybeSingle();

    if (fixErr) throw fixErr;
    if (!fixtureRow) {
      throw new Error(`SECURITY VIOLATION: Existing non-synthetic agency '${slug}' cannot be converted to a synthetic rehearsal fixture via --synthetic.`);
    }
  }

  // 3. Server-Side Atomic Provisioning RPC
  const { data: rpcResult, error: rpcErr } = await client.rpc("provision_agency_manifest_atomic", {
    p_manifest: manifest,
    p_is_synthetic: !!options.isSynthetic,
    p_rehearsal_run_id: options.rehearsalRunId || null
  });

  if (rpcErr) {
    throw new Error(`PROVISIONING_FAILED: ${rpcErr.message}`);
  }

  if (!rpcResult || !rpcResult.ok) {
    throw new Error(`PROVISIONING_FAILED: ${rpcResult?.error || "Unknown RPC error"}`);
  }

  return {
    ok: true,
    agencyId: rpcResult.agency_id,
    slug: rpcResult.slug,
    appliedActions: [
      { entity: "agency", action: "UPSERTED", id: rpcResult.agency_id, slug: rpcResult.slug },
      { entity: "ui_profile", action: "UPSERTED" },
      { entity: "domains", action: "UPSERTED" },
      { entity: "bank_accounts", action: "UPSERTED" },
      { entity: "offerings", action: "UPSERTED" },
      { entity: "memberships", action: "UPSERTED" }
    ]
  };
}

/**
 * 10E: Comprehensive V5 & Agency Readiness Verification
 */
export async function verifyAgencyReadiness(slug, options = {}) {
  const client = options.supabaseClient || defaultSupabase;

  const checks = {
    AGENCY_EXISTS: false,
    DOMAINS_MAPPED: false,
    DOMAIN_COLLISION_FREE: false,
    UI_PROFILE_COMPLETE: false,
    BANK_CONFIG_COMPLETE: false,
    OFFERINGS_COMPLETE: false,
    COURSE_MAPPING_COMPLETE: false,
    V5_COURSE_MAPPED: false,
    V5_RELEASE_VALID: false,
    STAFF_MEMBERSHIP_ACTIVE: false,
    HOMEWORK_READY: false
  };

  const details = {};

  // 1. AGENCY_EXISTS
  const { data: agency, error: agErr } = await client
    .from("agencies")
    .select("id, slug, name, status")
    .eq("slug", slug)
    .maybeSingle();

  if (agErr || !agency) {
    details.agency = "Agency record not found in database.";
    return { ok: false, checks, details };
  }
  checks.AGENCY_EXISTS = agency.status === "active";
  const agencyId = agency.id;

  // 2. DOMAINS_MAPPED & 3. DOMAIN_COLLISION_FREE
  const { data: domains, error: domErr } = await client
    .from("agency_domains")
    .select("id, hostname, status, is_primary")
    .eq("agency_id", agencyId);

  if (!domErr && domains && domains.length > 0) {
    checks.DOMAINS_MAPPED = true;
    let collisionDetected = false;
    for (const d of domains) {
      const { data: others } = await client
        .from("agency_domains")
        .select("id, agency_id")
        .eq("hostname", d.hostname)
        .neq("agency_id", agencyId);

      if (others && others.length > 0) {
        collisionDetected = true;
        details.collision = `Domain ${d.hostname} registered to multiple agencies!`;
        break;
      }
    }
    if (!collisionDetected) checks.DOMAIN_COLLISION_FREE = true;
  }

  // 4. UI_PROFILE_COMPLETE
  const { data: uiProfile, error: uiErr } = await client
    .from("agency_ui_profiles")
    .select("brand_name, storefront_variant, checkout_variant, admin_variant, learner_variant, learning_variant, homework_variant")
    .eq("agency_id", agencyId)
    .maybeSingle();

  if (!uiErr && uiProfile) {
    const required = [
      uiProfile.brand_name,
      uiProfile.storefront_variant,
      uiProfile.checkout_variant,
      uiProfile.admin_variant,
      uiProfile.learner_variant,
      uiProfile.learning_variant,
      uiProfile.homework_variant
    ];
    if (required.every(v => typeof v === "string" && v.length > 0)) {
      checks.UI_PROFILE_COMPLETE = true;
    }
    if (uiProfile.homework_variant) checks.HOMEWORK_READY = true;
  }

  // 5. BANK_CONFIG_COMPLETE
  const { data: banks } = await client
    .from("agency_bank_accounts")
    .select("id, is_active")
    .eq("agency_id", agencyId)
    .eq("is_active", true);

  if (banks && banks.length > 0) checks.BANK_CONFIG_COMPLETE = true;

  // 6. OFFERINGS_COMPLETE & 7. COURSE_MAPPING_COMPLETE
  const { data: offerings } = await client
    .from("agency_offerings")
    .select("id, slug, is_published")
    .eq("agency_id", agencyId)
    .eq("is_published", true);

  if (offerings && offerings.length > 0) {
    checks.OFFERINGS_COMPLETE = true;
    let allItemsMapped = true;
    const courseIds = [];

    for (const off of offerings) {
      const { data: items } = await client
        .from("agency_offering_items")
        .select("id, canonical_course_id")
        .eq("agency_id", agencyId)
        .eq("offering_id", off.id);

      if (!items || items.length === 0) {
        allItemsMapped = false;
        break;
      }
      for (const it of items) {
        if (!it.canonical_course_id) allItemsMapped = false;
        else courseIds.push(it.canonical_course_id);
      }
    }
    if (allItemsMapped && courseIds.length > 0) {
      checks.COURSE_MAPPING_COMPLETE = true;

      // 10E: Deep V5 Verification
      let v5Mapped = true;
      let v5ReleaseValid = true;

      for (const cId of courseIds) {
        const { data: cc } = await client
          .from("canonical_courses")
          .select("id, course_id, status")
          .eq("id", cId)
          .maybeSingle();

        if (!cc || !cc.course_id || cc.status !== "published") {
          v5Mapped = false;
          break;
        }

        // Check V5 course config & published release
        const { data: v5Config } = await client
          .from("v5_course_configs")
          .select("status, published_release_id")
          .eq("course_id", cc.course_id)
          .maybeSingle();

        if (!v5Config || v5Config.status !== "published" || !v5Config.published_release_id) {
          v5ReleaseValid = false;
          break;
        }

        const { data: v5Rel } = await client
          .from("v5_releases")
          .select("id, status, snapshot")
          .eq("id", v5Config.published_release_id)
          .eq("status", "published")
          .maybeSingle();

        if (!v5Rel || !v5Rel.snapshot) {
          v5ReleaseValid = false;
          break;
        }

        // Verify canonical lessons exist for this course and provide valid v5_lesson_id mapping (FIX 7C)
        const { data: cLessons } = await client
          .from("canonical_lessons")
          .select("id, v5_lesson_id")
          .eq("canonical_course_id", cId);

        if (!cLessons || cLessons.length === 0 || !cLessons.some(l => l.v5_lesson_id)) {
          v5ReleaseValid = false;
          break;
        }
      }

      checks.V5_COURSE_MAPPED = v5Mapped;
      checks.V5_RELEASE_VALID = v5ReleaseValid;
    }
  }

  // 8. STAFF_MEMBERSHIP_ACTIVE (10D: Allowed role check)
  const { data: staffMembers } = await client
    .from("agency_memberships")
    .select("id, role, status")
    .eq("agency_id", agencyId)
    .in("role", ["agency_staff", "agency_owner"])
    .eq("status", "active");

  if (staffMembers && staffMembers.length > 0) {
    checks.STAFF_MEMBERSHIP_ACTIVE = true;
  }

  const allPassed = Object.values(checks).every(Boolean);

  return {
    ok: allPassed,
    slug,
    agencyId,
    checks,
    details
  };
}

/**
 * Phase 6 & Phase 11: Trusted Synthetic Fixture Deprovision Safety.
 * Protected agencies ("yeunauan", "agency-a") can NEVER be deprovisioned.
 * Synthetic fixtures are deprovisioned atomically via deprovision_synthetic_agency_atomic RPC.
 */
export async function deprovisionAgency(slug, options = {}) {
  if (!slug || typeof slug !== "string") {
    throw new Error("deprovisionAgency requires a valid agency slug.");
  }

  // 1. HARD SHIELD: Protected agencies can NEVER be deprovisioned under any condition
  if (PROTECTED_SLUGS.has(slug)) {
    throw new Error(`SECURITY VIOLATION: Cannot deprovision protected agency '${slug}'.`);
  }

  if (!options.confirm) {
    throw new Error("deprovisionAgency requires options.confirm = true to execute deletion.");
  }

  const client = options.supabaseClient || defaultSupabase;

  // 2. Safe Deprovision Invariant: target authority comes from server-controlled
  // PRE_M0C_TEST_* configuration, never from caller flags.
  const trustedTarget = assertTrustedSyntheticTestTarget(options, client);

  if (!options.rehearsalRunId) {
    throw new Error("SECURITY VIOLATION: Deprovisioning requires options.rehearsalRunId.");
  }

  const { data: agency, error: agErr } = await client
    .from("agencies")
    .select("id, slug")
    .eq("slug", slug)
    .maybeSingle();

  if (agErr) throw agErr;
  if (!agency) {
    return { ok: true, deleted: false, message: `Agency '${slug}' does not exist.` };
  }

  // 3. Verify trusted synthetic fixture record
  const { data: fixtureRow, error: fixErr } = await client
    .from("agency_test_fixtures")
    .select("id, run_id, environment_fingerprint")
    .eq("agency_id", agency.id)
    .maybeSingle();

  if (fixErr) throw fixErr;
  if (!fixtureRow) {
    throw new Error(`SECURITY VIOLATION: Cannot deprovision tenant '${slug}'. Database record lacks matching synthetic test marker for rehearsal run ID '${options.rehearsalRunId}'.`);
  }

  if (fixtureRow.run_id !== options.rehearsalRunId) {
    throw new Error(`SECURITY VIOLATION: Cannot deprovision tenant '${slug}'. Database record lacks matching synthetic test marker for rehearsal run ID '${options.rehearsalRunId}'.`);
  }
  if (fixtureRow.environment_fingerprint !== trustedTarget.environmentFingerprint) {
    throw new Error(
      `SECURITY VIOLATION: Fixture environment fingerprint does not match the active isolated test target.`
    );
  }

  // 4. Atomic Deprovision RPC
  const { data: rpcRes, error: rpcErr } = await client.rpc("deprovision_synthetic_agency_atomic", {
    p_agency_id: agency.id,
    p_run_id: options.rehearsalRunId
  });

  if (rpcErr) {
    throw new Error(`DEPROVISION_FAILED: ${rpcErr.message}`);
  }

  if (!rpcRes || !rpcRes.ok) {
    throw new Error(`DEPROVISION_FAILED: ${rpcRes?.error || "Unknown deprovision error"}`);
  }

  return {
    ok: true,
    deleted: true,
    agencyId: agency.id,
    slug
  };
}
