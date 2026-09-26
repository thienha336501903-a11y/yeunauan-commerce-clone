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
import { supabase as defaultSupabase } from "./supabase.js";

// Protected agency slugs that can NEVER be deprovisioned under any circumstances
const PROTECTED_SLUGS = new Set(["yeunauan", "agency-a"]);
const VALID_MEMBERSHIP_ROLES = new Set(["student", "agency_staff", "agency_owner"]);

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

  // 4. Bank Accounts (Routing configuration reference)
  if (!Array.isArray(manifest.bank_accounts) || manifest.bank_accounts.length === 0) {
    throw new Error("Invalid manifest: 'bank_accounts' must have at least one active bank routing configuration.");
  }
  for (const b of manifest.bank_accounts) {
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
  }

  // 6. Principals & Membership Roles (10D: Valid Role Enum)
  if (manifest.principals) {
    if (!Array.isArray(manifest.principals)) {
      throw new Error("Invalid manifest: 'principals' must be an array.");
    }
    for (const p of manifest.principals) {
      if (p.role && !VALID_MEMBERSHIP_ROLES.has(p.role)) {
        throw new Error(`Invalid manifest: Role '${p.role}' for principal '${p.email || p.display_name}' is not allowed. Valid roles: ${Array.from(VALID_MEMBERSHIP_ROLES).join(", ")}`);
      }
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

  // 4. Check bank accounts
  if (manifest.commerce?.bank_accounts) {
    for (const b of manifest.commerce.bank_accounts) {
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
 * Apply mode: Applies the manifest to the database idempotently.
 * Enforces Phase 10B: Domain collision check BEFORE any agency/UI write.
 * Enforces Phase 10C: Never mutate shared canonical mapping.
 */
export async function applyAgencyProvisioning(manifest, options = {}) {
  validateManifest(manifest);
  const client = options.supabaseClient || defaultSupabase;
  const slug = manifest.agency.slug;

  const appliedActions = [];

  // ---------------------------------------------------------------------------
  // 10B: PRE-CHECK DOMAIN COLLISIONS BEFORE ANY WRITES
  // ---------------------------------------------------------------------------
  const { data: existingAgency, error: agLookupErr } = await client
    .from("agencies")
    .select("id, slug, name, status")
    .eq("slug", slug)
    .maybeSingle();

  if (agLookupErr) throw agLookupErr;
  let agencyId = existingAgency?.id || null;

  for (const d of manifest.domains) {
    const { data: collision, error: colErr } = await client
      .from("agency_domains")
      .select("id, agency_id, hostname")
      .eq("hostname", d.hostname)
      .maybeSingle();

    if (colErr) throw colErr;

    if (collision && collision.agency_id !== agencyId) {
      throw new Error(`SECURITY VIOLATION: Domain collision detected! Hostname '${d.hostname}' is already registered to agency ID '${collision.agency_id}'. No changes were made.`);
    }
  }

  // ---------------------------------------------------------------------------
  // 10C: PRE-CHECK CANONICAL COURSE CONFLICTS BEFORE ANY WRITES
  // ---------------------------------------------------------------------------
  if (manifest.learning?.courses) {
    for (const c of manifest.learning.courses) {
      const { data: exCc, error: ccErr } = await client
        .from("canonical_courses")
        .select("id, code, course_id")
        .eq("code", c.code)
        .maybeSingle();

      if (ccErr) throw ccErr;
      if (exCc && exCc.course_id && c.course_id && exCc.course_id !== c.course_id) {
        throw new Error(`CONFLICT: Conflicting canonical course mapping for '${c.code}'. Shared canonical curriculum cannot be overwritten.`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Ensure Agency Record
  // ---------------------------------------------------------------------------
  if (!existingAgency) {
    const insertPayload = {
      slug,
      name: manifest.agency.name,
      status: manifest.agency.status || "active"
    };

    const { data: newAgency, error: createAgErr } = await client
      .from("agencies")
      .insert(insertPayload)
      .select("id, slug")
      .single();

    if (createAgErr) throw createAgErr;
    agencyId = newAgency.id;
    appliedActions.push({ entity: "agency", action: "CREATED", id: agencyId, slug });
  } else {
    agencyId = existingAgency.id;
    const { error: updateAgErr } = await client
      .from("agencies")
      .update({
        name: manifest.agency.name,
        status: manifest.agency.status || existingAgency.status,
        updated_at: new Date().toISOString()
      })
      .eq("id", agencyId);

    if (updateAgErr) throw updateAgErr;
    appliedActions.push({ entity: "agency", action: "UPDATED", id: agencyId, slug });
  }

  // ---------------------------------------------------------------------------
  // 2. Upsert UI Profile (All 6 variants)
  // ---------------------------------------------------------------------------
  const uiPayload = {
    agency_id: agencyId,
    brand_name: manifest.ui.brand_name,
    logo_url: manifest.ui.logo_url || null,
    favicon_url: manifest.ui.favicon_url || null,
    storefront_variant: manifest.ui.storefront_variant,
    checkout_variant: manifest.ui.checkout_variant,
    admin_variant: manifest.ui.admin_variant,
    learner_variant: manifest.ui.learner_variant,
    learning_variant: manifest.ui.learning_variant,
    homework_variant: manifest.ui.homework_variant,
    design_tokens: manifest.ui.design_tokens || {},
    feature_flags: {
      ...(manifest.ui.feature_flags || {}),
      ...(options.isSynthetic && options.rehearsalRunId ? {
        synthetic_rehearsal: true,
        rehearsal_run_id: options.rehearsalRunId
      } : {})
    },
    updated_at: new Date().toISOString()
  };

  const { error: uiErr } = await client
    .from("agency_ui_profiles")
    .upsert(uiPayload, { onConflict: "agency_id" });

  if (uiErr) throw uiErr;
  appliedActions.push({ entity: "ui_profile", action: "UPSERTED", agencyId });

  // ---------------------------------------------------------------------------
  // 3. Upsert Domains
  // ---------------------------------------------------------------------------
  for (const d of manifest.domains) {
    const { data: existingDomain } = await client
      .from("agency_domains")
      .select("id, hostname")
      .eq("agency_id", agencyId)
      .eq("hostname", d.hostname)
      .maybeSingle();

    if (!existingDomain) {
      const { error: insDomErr } = await client
        .from("agency_domains")
        .insert({
          agency_id: agencyId,
          hostname: d.hostname,
          is_primary: !!d.is_primary,
          ssl_status: d.ssl_status || "active",
          status: "active"
        });
      if (insDomErr) throw insDomErr;
      appliedActions.push({ entity: "domain", action: "CREATED", hostname: d.hostname });
    } else {
      const { error: upDomErr } = await client
        .from("agency_domains")
        .update({
          is_primary: !!d.is_primary,
          ssl_status: d.ssl_status || "active",
          status: "active"
        })
        .eq("id", existingDomain.id);
      if (upDomErr) throw upDomErr;
      appliedActions.push({ entity: "domain", action: "UPDATED", hostname: d.hostname });
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Upsert Bank Accounts
  // ---------------------------------------------------------------------------
  if (manifest.bank_accounts) {
    for (const b of manifest.bank_accounts) {
      const { data: existingBank, error: bankErr } = await client
        .from("agency_bank_accounts")
        .select("id")
        .eq("agency_id", agencyId)
        .eq("bank_code", b.bank_code)
        .eq("account_number", b.account_number)
        .maybeSingle();

      if (bankErr) throw bankErr;

      if (!existingBank) {
        const { error: insBankErr } = await client
          .from("agency_bank_accounts")
          .insert({
            agency_id: agencyId,
            bank_code: b.bank_code,
            account_number: b.account_number,
            account_holder: b.account_holder,
            branch: b.branch || null,
            is_active: b.is_active !== undefined ? b.is_active : true,
            is_default: !!b.is_default
          });
        if (insBankErr) throw insBankErr;
        appliedActions.push({ entity: "bank_account", action: "CREATED", bank_code: b.bank_code });
      } else {
        const { error: upBankErr } = await client
          .from("agency_bank_accounts")
          .update({
            account_holder: b.account_holder,
            branch: b.branch || null,
            is_active: b.is_active !== undefined ? b.is_active : true,
            is_default: !!b.is_default
          })
          .eq("id", existingBank.id);
        if (upBankErr) throw upBankErr;
        appliedActions.push({ entity: "bank_account", action: "UPDATED", bank_code: b.bank_code });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Canonical Courses / Lessons (Learning platform core)
  // 10C Invariant: Never overwrite existing course_id
  // ---------------------------------------------------------------------------
  const canonicalCourseMap = new Map();
  if (manifest.learning?.courses) {
    for (const c of manifest.learning.courses) {
      let canonicalId = null;
      const { data: exCc, error: ccErr } = await client
        .from("canonical_courses")
        .select("id, code, course_id")
        .eq("code", c.code)
        .maybeSingle();

      if (ccErr) throw ccErr;

      if (!exCc) {
        const { data: newCc, error: insCcErr } = await client
          .from("canonical_courses")
          .insert({
            code: c.code,
            default_title: c.title,
            course_id: c.course_id || null,
            status: "published",
            curriculum_metadata: c.curriculum_metadata || {}
          })
          .select("id, code")
          .single();
        if (insCcErr) throw insCcErr;
        canonicalId = newCc.id;
        appliedActions.push({ entity: "canonical_course", action: "CREATED", code: c.code });
      } else {
        canonicalId = exCc.id;
        // Do NOT overwrite course_id (10C)
        appliedActions.push({ entity: "canonical_course", action: "UNCHANGED", code: c.code });
      }

      canonicalCourseMap.set(c.code, canonicalId);

      // Lessons
      if (c.lessons) {
        for (const l of c.lessons) {
          const { data: exL, error: lErr } = await client
            .from("canonical_lessons")
            .select("id")
            .eq("canonical_course_id", canonicalId)
            .eq("sort_order", l.sort_order)
            .maybeSingle();

          if (lErr) throw lErr;

          if (!exL) {
            const { error: insLErr } = await client
              .from("canonical_lessons")
              .insert({
                canonical_course_id: canonicalId,
                v5_lesson_id: l.v5_lesson_id || null,
                title: l.title,
                sort_order: l.sort_order,
                is_free_preview: !!l.is_free_preview,
                duration_seconds: l.duration_seconds || 0
              });
            if (insLErr) throw insLErr;
            appliedActions.push({ entity: "canonical_lesson", action: "CREATED", title: l.title });
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Upsert Offerings and Offering Items (Phase 11 unique invariant safe)
  // ---------------------------------------------------------------------------
  if (manifest.offerings) {
    for (const off of manifest.offerings) {
      let offeringId = null;
      const { data: exOff, error: offErr } = await client
        .from("agency_offerings")
        .select("id")
        .eq("agency_id", agencyId)
        .eq("slug", off.slug)
        .maybeSingle();

      if (offErr) throw offErr;

      const offPayload = {
        agency_id: agencyId,
        slug: off.slug,
        display_title: off.display_title,
        display_description: off.display_description || null,
        thumbnail_url: off.thumbnail_url || null,
        price_vnd: Number(off.price_vnd),
        sale_price_vnd: off.sale_price_vnd !== undefined ? Number(off.sale_price_vnd) : null,
        is_published: off.is_published !== undefined ? Boolean(off.is_published) : true,
        sort_order: off.sort_order || 0
      };

      if (!exOff) {
        const { data: newOff, error: insOffErr } = await client
          .from("agency_offerings")
          .insert(offPayload)
          .select("id")
          .single();
        if (insOffErr) throw insOffErr;
        offeringId = newOff.id;
        appliedActions.push({ entity: "offering", action: "CREATED", slug: off.slug });
      } else {
        offeringId = exOff.id;
        const { error: upOffErr } = await client
          .from("agency_offerings")
          .update(offPayload)
          .eq("id", offeringId);
        if (upOffErr) throw upOffErr;
        appliedActions.push({ entity: "offering", action: "UPDATED", slug: off.slug });
      }

      // Upsert Items with unique invariant (agency_id, offering_id, canonical_course_id)
      if (off.items) {
        for (const it of off.items) {
          const canonicalCourseId = canonicalCourseMap.get(it.canonical_course_code) || it.canonical_course_id;
          if (!canonicalCourseId) {
            throw new Error(`Offering item references unresolvable canonical course '${it.canonical_course_code || it.canonical_course_id}'.`);
          }

          const { data: exItem } = await client
            .from("agency_offering_items")
            .select("id")
            .eq("agency_id", agencyId)
            .eq("offering_id", offeringId)
            .eq("canonical_course_id", canonicalCourseId)
            .maybeSingle();

          if (!exItem) {
            const { error: insItemErr } = await client
              .from("agency_offering_items")
              .insert({
                agency_id: agencyId,
                offering_id: offeringId,
                canonical_course_id: canonicalCourseId,
                item_type: "canonical_course",
                sort_order: it.sort_order || 1
              });
            if (insItemErr) throw insItemErr;
            appliedActions.push({ entity: "offering_item", action: "CREATED", offeringId, canonicalCourseId });
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Principals & Memberships (10D: Valid Role Enum Only)
  // ---------------------------------------------------------------------------
  if (manifest.principals) {
    for (const p of manifest.principals) {
      const role = p.role && VALID_MEMBERSHIP_ROLES.has(p.role) ? p.role : "agency_staff";
      let userId = p.user_id;

      if (!userId && p.email) {
        const { data: userList } = await client.auth.admin.listUsers();
        const found = userList?.users?.find(u => u.email === p.email);
        if (found) {
          userId = found.id;
        } else if (options.createMissingUsers) {
          const { data: created, error: cErr } = await client.auth.admin.createUser({
            email: p.email,
            email_confirm: true,
            password: crypto.randomBytes(16).toString("hex") + "!Aa1"
          });
          if (cErr) throw cErr;
          userId = created.user.id;
        }
      }

      if (userId) {
        const { data: exMem } = await client
          .from("agency_memberships")
          .select("id, role, status")
          .eq("agency_id", agencyId)
          .eq("user_id", userId)
          .maybeSingle();

        if (!exMem) {
          const { error: insMemErr } = await client
            .from("agency_memberships")
            .insert({
              agency_id: agencyId,
              user_id: userId,
              role,
              status: "active",
              display_name: p.display_name || p.email || "Agency Staff",
              phone: p.phone || null
            });
          if (insMemErr) throw insMemErr;
          appliedActions.push({ entity: "membership", action: "CREATED", userId, role });
        } else {
          const { error: upMemErr } = await client
            .from("agency_memberships")
            .update({ role, status: "active" })
            .eq("id", exMem.id);
          if (upMemErr) throw upMemErr;
          appliedActions.push({ entity: "membership", action: "UPDATED", userId, role });
        }
      }
    }
  }

  return {
    ok: true,
    agencyId,
    slug,
    appliedActions
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

        // Verify canonical lessons exist for this course
        const { data: cLessons } = await client
          .from("canonical_lessons")
          .select("id")
          .eq("canonical_course_id", cId)
          .limit(1);

        if (!cLessons || cLessons.length === 0) {
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
 * Phase 11: Deprovision Safety
 * STRICT INVARIANT:
 * Protected agencies ("yeunauan", "agency-a") CAN NEVER BE DEPROVISIONED.
 * A tenant is removable ONLY IF:
 * 1. Running against an explicit allowed test target (options.isTestTarget === true) AND
 * 2. Database agency record carries a trusted synthetic test marker matching options.rehearsalRunId!
 * Removing synthetic caller flag as sole proof.
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

  // 2. Phase 11 Safe Deprovision Invariant: Must be explicit test target
  if (!options.isTestTarget) {
    throw new Error("SECURITY VIOLATION: Deprovisioning is only permitted when options.isTestTarget is explicitly true.");
  }

  const client = options.supabaseClient || defaultSupabase;

  const { data: agency, error: agErr } = await client
    .from("agencies")
    .select("id, slug")
    .eq("slug", slug)
    .maybeSingle();

  if (agErr) throw agErr;
  if (!agency) {
    return { ok: true, deleted: false, message: `Agency '${slug}' does not exist.` };
  }

  // 3. Phase 11 Safe Deprovision Invariant: Must carry trusted synthetic marker created by rehearsal
  if (!options.rehearsalRunId) {
    throw new Error("SECURITY VIOLATION: Deprovisioning requires options.rehearsalRunId.");
  }

  const { data: uiProfile, error: uiErr } = await client
    .from("agency_ui_profiles")
    .select("feature_flags")
    .eq("agency_id", agency.id)
    .maybeSingle();

  if (uiErr) throw uiErr;

  const isSynthetic = uiProfile?.feature_flags?.synthetic_rehearsal === true &&
    uiProfile?.feature_flags?.rehearsal_run_id === options.rehearsalRunId;

  if (!isSynthetic) {
    throw new Error(`SECURITY VIOLATION: Cannot deprovision tenant '${slug}'. Database record lacks matching synthetic test marker for rehearsal run ID '${options.rehearsalRunId}'.`);
  }

  const agencyId = agency.id;
  const deletedCounts = {};

  // Delete in reverse foreign-key order
  const tenantTables = [
    { table: "agency_homework_submissions", key: "agency_id" },
    { table: "agency_lesson_progress", key: "agency_id" },
    { table: "entitlement_grants", key: "agency_id" },
    { table: "student_entitlements", key: "agency_id" },
    { table: "order_items", key: "agency_id" },
    { table: "agency_orders", key: "agency_id" },
    { table: "student_devices", key: "agency_id" },
    { table: "agency_memberships", key: "agency_id" },
    { table: "agency_offering_items", key: "agency_id" },
    { table: "agency_offerings", key: "agency_id" },
    { table: "agency_bank_accounts", key: "agency_id" },
    { table: "agency_ui_profiles", key: "agency_id" },
    { table: "agency_domains", key: "agency_id" }
  ];

  for (const { table, key } of tenantTables) {
    const { error: delErr, count } = await client
      .from(table)
      .delete({ count: "exact" })
      .eq(key, agencyId);

    if (delErr) throw delErr;
    deletedCounts[table] = count || 0;
  }

  // Finally delete agency
  const { error: agDelErr } = await client
    .from("agencies")
    .delete()
    .eq("id", agencyId);

  if (agDelErr) throw agDelErr;
  deletedCounts.agencies = 1;

  return {
    ok: true,
    deleted: true,
    agencyId,
    slug,
    deletedCounts
  };
}
