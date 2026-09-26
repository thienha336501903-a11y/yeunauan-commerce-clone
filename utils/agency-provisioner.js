// utils/agency-provisioner.js
// System B Milestone M0C — Idempotent Agency Provisioning Package & Lifecycle Engine
// Authoritative Plan: SYSTEM_B_MULTI_AGENCY_MASTER_IMPLEMENTATION_PLAN_V1_1.md
// Invariants:
//   1. Strict Idempotency: Running plan/apply repeatedly produces zero duplicates.
//   2. Cross-Tenant Isolation: No accidental overwrite or domain collisions across agencies.
//   3. Zero Secrets: Manifests must never contain secret keys, service tokens, or private keys.
//   4. Deterministic Validation: Fails closed across all 11 required readiness checks.

import crypto from "node:crypto";
import { supabase as defaultSupabase } from "./supabase.js";

// Protected agency slugs that cannot be deprovisioned or overwritten arbitrarily
const PROTECTED_SLUGS = new Set(["yeunauan", "agency-a"]);

/**
 * Validates manifest structure and ensures no secrets are present.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Invalid manifest: Manifest must be a non-null object.");
  }

  // 1. Agency
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
    throw new Error("Invalid manifest: 'domains' must be a non-empty array.");
  }
  for (const d of manifest.domains) {
    if (!d.hostname || typeof d.hostname !== "string") {
      throw new Error("Invalid manifest: Domain entry must have a valid 'hostname'.");
    }
  }

  // 3. UI Profile
  if (!manifest.ui || typeof manifest.ui !== "object") {
    throw new Error("Invalid manifest: Missing 'ui' profile configuration.");
  }
  const { brand_name, storefront_variant, checkout_variant, admin_variant, learner_variant, learning_variant, homework_variant } = manifest.ui;
  if (!brand_name) {
    throw new Error("Invalid manifest: UI profile must have 'brand_name'.");
  }

  // 4. Offerings
  if (manifest.offerings && !Array.isArray(manifest.offerings)) {
    throw new Error("Invalid manifest: 'offerings' must be an array.");
  }

  // 5. Principals
  if (manifest.principals && !Array.isArray(manifest.principals)) {
    throw new Error("Invalid manifest: 'principals' must be an array.");
  }

  // 6. Security scan: prevent secret credentials from entering the manifest
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

  // 2. Check domains & domain collisions
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
    } else {
      const needsUpdate = existingDomain.is_primary !== !!d.is_primary || (d.ssl_status && existingDomain.ssl_status !== d.ssl_status);
      if (needsUpdate) {
        actions.push({ entity: "domain", action: "UPDATE", details: { hostname: d.hostname } });
        summary.updates++;
      } else {
        actions.push({ entity: "domain", action: "UNCHANGED", details: { hostname: d.hostname } });
        summary.unchanged++;
      }
    }
  }

  // 3. Check UI profile
  if (agencyId) {
    const { data: existingProfile, error: uiErr } = await client
      .from("agency_ui_profiles")
      .select("agency_id, brand_name, storefront_variant, checkout_variant")
      .eq("agency_id", agencyId)
      .maybeSingle();

    if (uiErr) throw uiErr;

    if (!existingProfile) {
      actions.push({ entity: "ui_profile", action: "CREATE", details: { brand_name: manifest.ui.brand_name } });
      summary.creates++;
    } else {
      actions.push({ entity: "ui_profile", action: "UPDATE", details: { brand_name: manifest.ui.brand_name } });
      summary.updates++;
    }
  } else {
    actions.push({ entity: "ui_profile", action: "CREATE", details: { brand_name: manifest.ui.brand_name } });
    summary.creates++;
  }

  // 4. Check bank accounts
  if (manifest.bank_accounts && manifest.bank_accounts.length > 0) {
    let existingBankAccounts = [];
    if (agencyId) {
      const { data: bData, error: bErr } = await client
        .from("agency_bank_accounts")
        .select("id, bank_code, account_number, is_active, is_default")
        .eq("agency_id", agencyId);
      if (bErr) throw bErr;
      existingBankAccounts = bData || [];
    }

    for (const b of manifest.bank_accounts) {
      const match = existingBankAccounts.find(
        (ex) => ex.bank_code === b.bank_code && ex.account_number === b.account_number
      );
      if (!match) {
        actions.push({ entity: "bank_account", action: "CREATE", details: { bank_code: b.bank_code, account_number: b.account_number } });
        summary.creates++;
      } else {
        actions.push({ entity: "bank_account", action: "UNCHANGED", details: { bank_code: b.bank_code, account_number: b.account_number } });
        summary.unchanged++;
      }
    }
  }

  // 5. Check offerings
  if (manifest.offerings && manifest.offerings.length > 0) {
    let existingOfferings = [];
    if (agencyId) {
      const { data: offData, error: offErr } = await client
        .from("agency_offerings")
        .select("id, slug, display_title, price_vnd, is_published")
        .eq("agency_id", agencyId);
      if (offErr) throw offErr;
      existingOfferings = offData || [];
    }

    for (const off of manifest.offerings) {
      const match = existingOfferings.find((ex) => ex.slug === off.slug);
      if (!match) {
        actions.push({ entity: "offering", action: "CREATE", details: { slug: off.slug, title: off.display_title } });
        summary.creates++;
      } else {
        const needsUpdate = match.display_title !== off.display_title || Number(match.price_vnd) !== Number(off.price_vnd);
        if (needsUpdate) {
          actions.push({ entity: "offering", action: "UPDATE", details: { slug: off.slug } });
          summary.updates++;
        } else {
          actions.push({ entity: "offering", action: "UNCHANGED", details: { slug: off.slug } });
          summary.unchanged++;
        }
      }
    }
  }

  return {
    ok: true,
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
 */
export async function applyAgencyProvisioning(manifest, options = {}) {
  validateManifest(manifest);
  const client = options.supabaseClient || defaultSupabase;
  const slug = manifest.agency.slug;

  const appliedActions = [];

  // 1. Ensure Agency
  let agencyId = null;
  const { data: existingAgency, error: agErr } = await client
    .from("agencies")
    .select("id, slug, name, status")
    .eq("slug", slug)
    .maybeSingle();

  if (agErr) throw agErr;

  if (!existingAgency) {
    const { data: newAgency, error: createAgErr } = await client
      .from("agencies")
      .insert({
        slug,
        name: manifest.agency.name,
        status: manifest.agency.status || "active"
      })
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

  // 2. Upsert UI Profile
  const uiPayload = {
    agency_id: agencyId,
    brand_name: manifest.ui.brand_name,
    logo_url: manifest.ui.logo_url || null,
    favicon_url: manifest.ui.favicon_url || null,
    storefront_variant: manifest.ui.storefront_variant || "classic_culinary",
    checkout_variant: manifest.ui.checkout_variant || "one_page_qr",
    admin_variant: manifest.ui.admin_variant || "standard_agency",
    learner_variant: manifest.ui.learner_variant || "card_dashboard",
    learning_variant: manifest.ui.learning_variant || "cinema_player",
    homework_variant: manifest.ui.homework_variant || "photo_submission",
    design_tokens: manifest.ui.design_tokens || {},
    feature_flags: manifest.ui.feature_flags || {},
    updated_at: new Date().toISOString()
  };

  const { error: uiErr } = await client
    .from("agency_ui_profiles")
    .upsert(uiPayload, { onConflict: "agency_id" });

  if (uiErr) throw uiErr;
  appliedActions.push({ entity: "ui_profile", action: "UPSERTED", agencyId });

  // 3. Upsert Domains with Strict Collision Prevention
  for (const d of manifest.domains) {
    const { data: collision, error: colErr } = await client
      .from("agency_domains")
      .select("id, agency_id, hostname")
      .eq("hostname", d.hostname)
      .maybeSingle();

    if (colErr) throw colErr;

    if (collision && collision.agency_id !== agencyId) {
      throw new Error(`SECURITY VIOLATION: Domain collision detected! Hostname '${d.hostname}' is already registered to agency ID '${collision.agency_id}'.`);
    }

    if (!collision) {
      const { error: insDomErr } = await client
        .from("agency_domains")
        .insert({
          agency_id: agencyId,
          hostname: d.hostname,
          is_primary: !!d.is_primary,
          ssl_status: d.ssl_status || "active"
        });
      if (insDomErr) throw insDomErr;
      appliedActions.push({ entity: "domain", action: "CREATED", hostname: d.hostname });
    } else {
      const { error: upDomErr } = await client
        .from("agency_domains")
        .update({
          is_primary: !!d.is_primary,
          ssl_status: d.ssl_status || "active"
        })
        .eq("id", collision.id);
      if (upDomErr) throw upDomErr;
      appliedActions.push({ entity: "domain", action: "UPDATED", hostname: d.hostname });
    }
  }

  // 4. Upsert Bank Accounts
  if (manifest.bank_accounts && manifest.bank_accounts.length > 0) {
    for (const b of manifest.bank_accounts) {
      const { data: existingBank, error: bankErr } = await client
        .from("agency_bank_accounts")
        .select("id, agency_id, bank_code, account_number")
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
        appliedActions.push({ entity: "bank_account", action: "CREATED", bank_code: b.bank_code, account_number: b.account_number });
      } else {
        const { error: upBankErr } = await client
          .from("agency_bank_accounts")
          .update({
            account_holder: b.account_holder,
            branch: b.branch || null,
            is_active: b.is_active !== undefined ? b.is_active : true,
            is_default: !!b.is_default
          })
          .eq("agency_id", agencyId)
          .eq("id", existingBank.id);
        if (upBankErr) throw upBankErr;
        appliedActions.push({ entity: "bank_account", action: "UPDATED", bank_code: b.bank_code, account_number: b.account_number });
      }
    }
  }

  // 5. Canonical Courses / Lessons (Learning platform core)
  const canonicalCourseMap = new Map();
  if (manifest.learning?.courses && manifest.learning.courses.length > 0) {
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
        if (c.course_id && exCc.course_id !== c.course_id) {
          await client.from("canonical_courses").update({ course_id: c.course_id }).eq("id", canonicalId);
        }
        appliedActions.push({ entity: "canonical_course", action: "UNCHANGED", code: c.code });
      }

      canonicalCourseMap.set(c.code, canonicalId);

      // Lessons
      if (c.lessons && c.lessons.length > 0) {
        for (const l of c.lessons) {
          const { data: exL, error: lErr } = await client
            .from("canonical_lessons")
            .select("id, canonical_course_id, sort_order")
            .eq("canonical_course_id", canonicalId)
            .eq("sort_order", l.sort_order)
            .maybeSingle();
          if (lErr) throw lErr;

          if (!exL) {
            await client.from("canonical_lessons").insert({
              canonical_course_id: canonicalId,
              title: l.title,
              sort_order: l.sort_order,
              v5_lesson_id: l.v5_lesson_id || null,
              is_free_preview: !!l.is_free_preview
            });
            appliedActions.push({ entity: "canonical_lesson", action: "CREATED", title: l.title });
          }
        }
      }
    }
  }

  // Pre-load all canonical courses if needed for offering resolution
  const { data: allCanonical } = await client.from("canonical_courses").select("id, code");
  if (allCanonical) {
    for (const ac of allCanonical) {
      canonicalCourseMap.set(ac.code, ac.id);
      canonicalCourseMap.set(ac.id, ac.id);
    }
  }

  // 6. Offerings & Items
  if (manifest.offerings && manifest.offerings.length > 0) {
    for (const off of manifest.offerings) {
      let offeringId = null;
      const { data: exOff, error: offErr } = await client
        .from("agency_offerings")
        .select("id, slug")
        .eq("agency_id", agencyId)
        .eq("slug", off.slug)
        .maybeSingle();

      if (offErr) throw offErr;

      if (!exOff) {
        const { data: newOff, error: insOffErr } = await client
          .from("agency_offerings")
          .insert({
            agency_id: agencyId,
            slug: off.slug,
            display_title: off.display_title,
            display_description: off.display_description || null,
            thumbnail_url: off.thumbnail_url || null,
            price_vnd: off.price_vnd || 0,
            sale_price_vnd: off.sale_price_vnd || null,
            is_published: off.is_published !== undefined ? off.is_published : true,
            sort_order: off.sort_order || 0
          })
          .select("id, slug")
          .single();
        if (insOffErr) throw insOffErr;
        offeringId = newOff.id;
        appliedActions.push({ entity: "offering", action: "CREATED", slug: off.slug });
      } else {
        offeringId = exOff.id;
        const { error: upOffErr } = await client
          .from("agency_offerings")
          .update({
            display_title: off.display_title,
            display_description: off.display_description || null,
            thumbnail_url: off.thumbnail_url || null,
            price_vnd: off.price_vnd || 0,
            sale_price_vnd: off.sale_price_vnd || null,
            is_published: off.is_published !== undefined ? off.is_published : true,
            sort_order: off.sort_order || 0,
            updated_at: new Date().toISOString()
          })
          .eq("agency_id", agencyId)
          .eq("id", offeringId);
        if (upOffErr) throw upOffErr;
        appliedActions.push({ entity: "offering", action: "UPDATED", slug: off.slug });
      }

      // Offering Items
      if (off.items && off.items.length > 0) {
        for (const item of off.items) {
          const canonicalCourseId = item.canonical_course_id || canonicalCourseMap.get(item.canonical_course_code);
          if (!canonicalCourseId) {
            throw new Error(`Referential failure: Offering '${off.slug}' item references unknown canonical course code '${item.canonical_course_code}'.`);
          }

          const { data: exItem, error: itemErr } = await client
            .from("agency_offering_items")
            .select("id, canonical_course_id")
            .eq("agency_id", agencyId)
            .eq("offering_id", offeringId)
            .eq("canonical_course_id", canonicalCourseId)
            .maybeSingle();

          if (itemErr) throw itemErr;

          if (!exItem) {
            const { error: insItemErr } = await client
              .from("agency_offering_items")
              .insert({
                agency_id: agencyId,
                offering_id: offeringId,
                canonical_course_id: canonicalCourseId,
                item_type: item.item_type || "canonical_course",
                sort_order: item.sort_order || 0
              });
            if (insItemErr) throw insItemErr;
            appliedActions.push({ entity: "offering_item", action: "CREATED", offeringId, canonicalCourseId });
          }
        }
      }
    }
  }

  // 7. Principals & Memberships
  if (manifest.principals && manifest.principals.length > 0) {
    for (const p of manifest.principals) {
      let userId = p.user_id;
      if (!userId && options.resolveUserId) {
        userId = await options.resolveUserId(p.email);
      }
      if (!userId) {
        if (options.allowSyntheticPrincipals) {
          if (client.auth?.admin?.createUser) {
            const { data: newUser, error: createUErr } = await client.auth.admin.createUser({
              email: p.email,
              email_confirm: true
            });
            if (!createUErr && newUser?.user?.id) {
              userId = newUser.user.id;
            } else {
              const { data: uList } = await client.auth.admin.listUsers();
              const match = uList?.users?.find((u) => u.email === p.email);
              if (match) userId = match.id;
            }
          }
          if (!userId) {
            userId = p.synthetic_user_id || crypto.randomUUID();
          }
        } else {
          throw new Error(`Principal resolution error: User ID could not be resolved for principal '${p.email}'.`);
        }
      }

      const { data: exMem, error: memErr } = await client
        .from("agency_memberships")
        .select("id, agency_id, user_id, role, status")
        .eq("agency_id", agencyId)
        .eq("user_id", userId)
        .maybeSingle();

      if (memErr) throw memErr;

      if (!exMem) {
        const { error: insMemErr } = await client
          .from("agency_memberships")
          .insert({
            agency_id: agencyId,
            user_id: userId,
            role: p.role || "agency_admin",
            display_name: p.display_name || p.email || "Agency Principal",
            phone: p.phone || null,
            status: p.status || "active"
          });
        if (insMemErr) throw insMemErr;
        appliedActions.push({ entity: "membership", action: "CREATED", userId, role: p.role });
      } else {
        const { error: upMemErr } = await client
          .from("agency_memberships")
          .update({
            role: p.role || exMem.role,
            display_name: p.display_name || exMem.display_name,
            phone: p.phone || exMem.phone,
            status: p.status || exMem.status,
            updated_at: new Date().toISOString()
          })
          .eq("agency_id", agencyId)
          .eq("id", exMem.id);
        if (upMemErr) throw upMemErr;
        appliedActions.push({ entity: "membership", action: "UPDATED", userId });
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
 * Validates the agency's configuration in the database against all 11 required readiness checks.
 * Fails closed if any requirement is unfulfilled.
 */
export async function validateAgencyProvisioning(slug, manifest = null, options = {}) {
  const client = options.supabaseClient || defaultSupabase;

  const checks = {
    AGENCY_EXISTS: false,
    DOMAINS_VALID: false,
    DOMAIN_COLLISION_FREE: false,
    UI_PROFILE_COMPLETE: false,
    BANK_CONFIG_COMPLETE: false,
    OFFERINGS_COMPLETE: false,
    COURSE_MAPPING_COMPLETE: false,
    V5_MAPPING_COMPLETE: false,
    PRINCIPALS_COMPLETE: false,
    MEMBERSHIPS_COMPLETE: false,
    HOMEWORK_READY: false
  };

  const details = {};

  // 1. AGENCY_EXISTS
  const { data: agency, error: agErr } = await client
    .from("agencies")
    .select("id, slug, name, status")
    .eq("slug", slug)
    .maybeSingle();

  if (agErr || !agency || agency.status !== "active") {
    details.agency = agency ? `Status: ${agency.status}` : "Agency record not found";
    return { ok: false, checks, details, error: "AGENCY_EXISTS failed" };
  }
  checks.AGENCY_EXISTS = true;
  const agencyId = agency.id;

  // 2. DOMAINS_VALID & 3. DOMAIN_COLLISION_FREE
  const { data: domains, error: domErr } = await client
    .from("agency_domains")
    .select("id, agency_id, hostname, is_primary, ssl_status")
    .eq("agency_id", agencyId);

  if (!domErr && domains && domains.length > 0) {
    const hasValidDomain = domains.some((d) => d.ssl_status === "active");
    if (hasValidDomain) {
      checks.DOMAINS_VALID = true;
    }

    // Check collision for each domain
    let collisionDetected = false;
    for (const d of domains) {
      const { data: others } = await client
        .from("agency_domains")
        .select("agency_id")
        .eq("hostname", d.hostname)
        .neq("agency_id", agencyId);

      if (others && others.length > 0) {
        collisionDetected = true;
        details.collision = `Domain ${d.hostname} registered to multiple agencies!`;
        break;
      }
    }
    if (!collisionDetected) {
      checks.DOMAIN_COLLISION_FREE = true;
    }
  }

  // 4. UI_PROFILE_COMPLETE
  const { data: uiProfile, error: uiErr } = await client
    .from("agency_ui_profiles")
    .select("brand_name, storefront_variant, checkout_variant, admin_variant, learner_variant, learning_variant, homework_variant")
    .eq("agency_id", agencyId)
    .maybeSingle();

  if (!uiErr && uiProfile) {
    const requiredVariants = [
      uiProfile.brand_name,
      uiProfile.storefront_variant,
      uiProfile.checkout_variant,
      uiProfile.admin_variant,
      uiProfile.learner_variant,
      uiProfile.learning_variant,
      uiProfile.homework_variant
    ];
    if (requiredVariants.every((v) => typeof v === "string" && v.length > 0)) {
      checks.UI_PROFILE_COMPLETE = true;
    }
    // 11. HOMEWORK_READY
    if (uiProfile.homework_variant && uiProfile.homework_variant.length > 0) {
      checks.HOMEWORK_READY = true;
    }
  }

  // 5. BANK_CONFIG_COMPLETE
  const { data: banks, error: bankErr } = await client
    .from("agency_bank_accounts")
    .select("id, bank_code, account_number, is_active, is_default")
    .eq("agency_id", agencyId)
    .eq("is_active", true);

  if (!bankErr && banks && banks.length > 0) {
    checks.BANK_CONFIG_COMPLETE = true;
  }

  // 6. OFFERINGS_COMPLETE & 7. COURSE_MAPPING_COMPLETE
  const { data: offerings, error: offErr } = await client
    .from("agency_offerings")
    .select("id, slug, is_published, price_vnd")
    .eq("agency_id", agencyId)
    .eq("is_published", true);

  if (!offErr && offerings && offerings.length > 0) {
    checks.OFFERINGS_COMPLETE = true;

    // Check course mapping for each offering
    let allItemsMapped = true;
    let foundItemsCount = 0;
    const courseIds = [];

    for (const off of offerings) {
      const { data: items, error: itErr } = await client
        .from("agency_offering_items")
        .select("id, canonical_course_id")
        .eq("agency_id", agencyId)
        .eq("offering_id", off.id);

      if (itErr || !items || items.length === 0) {
        allItemsMapped = false;
        break;
      }
      foundItemsCount += items.length;
      for (const it of items) {
        if (!it.canonical_course_id) {
          allItemsMapped = false;
          break;
        }
        courseIds.push(it.canonical_course_id);
      }
    }

    if (allItemsMapped && foundItemsCount > 0) {
      checks.COURSE_MAPPING_COMPLETE = true;

      // 8. V5_MAPPING_COMPLETE
      // Check that canonical courses reference a valid course in courses
      const { data: cCourses, error: ccErr } = await client
        .from("canonical_courses")
        .select("id, course_id")
        .in("id", courseIds);

      if (!ccErr && cCourses && cCourses.length > 0) {
        const validV5 = cCourses.every((cc) => cc.course_id !== null);
        if (validV5) {
          checks.V5_MAPPING_COMPLETE = true;
        }
      }
    }
  }

  // 9. PRINCIPALS_COMPLETE & 10. MEMBERSHIPS_COMPLETE
  const { data: members, error: memErr } = await client
    .from("agency_memberships")
    .select("id, user_id, role, status")
    .eq("agency_id", agencyId);

  if (!memErr && members && members.length > 0) {
    const hasAdminOrOwner = members.some(
      (m) => (m.role === "agency_admin" || m.role === "agency_owner") && m.status === "active"
    );
    if (hasAdminOrOwner) {
      checks.PRINCIPALS_COMPLETE = true;
    }
    const allMembersValid = members.every((m) => m.status === "active" && !!m.user_id);
    if (allMembersValid) {
      checks.MEMBERSHIPS_COMPLETE = true;
    }
  }

  const allPassed = Object.values(checks).every((v) => v === true);

  return {
    ok: allPassed,
    agencyId,
    slug,
    checks,
    details
  };
}

/**
 * Safely deprovisions an agency and deletes all its scoped child records in strict foreign-key order.
 * Strictly forbids deprovisioning protected slugs unless synthetic flags are set.
 */
export async function deprovisionAgency(slug, options = {}) {
  if (!slug || typeof slug !== "string") {
    throw new Error("deprovisionAgency requires a valid agency slug.");
  }

  if (PROTECTED_SLUGS.has(slug) && !options.forceSynthetic) {
    throw new Error(`SECURITY VIOLATION: Cannot deprovision protected agency '${slug}'.`);
  }

  if (!options.confirm) {
    throw new Error("deprovisionAgency requires options.confirm = true to execute deletion.");
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
