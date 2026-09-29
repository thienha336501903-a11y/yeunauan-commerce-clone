-- 20260927040000_multi_agency_m0c_final_security_closure.sql
-- System B Milestone M0C — Final pre-M0C security closure
-- Additive only. Does NOT edit prior applied migrations.
-- Hardens fixture authority, trusted synthetic-target gating, complete manifest
-- reference preflight, and preserves fail-closed domain ownership.

-- -----------------------------------------------------------------------------
-- 1. Fixture Registry Authority Immutability Trigger
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_prevent_agency_test_fixture_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.agency_id <> NEW.agency_id THEN
        RAISE EXCEPTION 'Immutable authority: agency_test_fixtures.agency_id cannot be changed';
    END IF;
    IF OLD.run_id <> NEW.run_id THEN
        RAISE EXCEPTION 'Immutable authority: agency_test_fixtures.run_id cannot be changed (run_id is immutable)';
    END IF;
    IF OLD.created_by_tool <> NEW.created_by_tool THEN
        RAISE EXCEPTION 'Immutable authority: agency_test_fixtures.created_by_tool cannot be changed';
    END IF;
    IF OLD.environment_fingerprint <> NEW.environment_fingerprint THEN
        RAISE EXCEPTION 'Immutable authority: agency_test_fixtures.environment_fingerprint cannot be changed';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agency_test_fixtures_immutable ON public.agency_test_fixtures;
CREATE TRIGGER trg_agency_test_fixtures_immutable
BEFORE UPDATE ON public.agency_test_fixtures
FOR EACH ROW EXECUTE FUNCTION public.trg_prevent_agency_test_fixture_mutation();

-- Direct fixture authority mutation is forbidden even to service_role.
-- Controlled SECURITY DEFINER provisioning/deprovisioning functions execute as owner.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.agency_test_fixtures FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.trg_prevent_agency_test_fixture_mutation() FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.agency_test_fixtures TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Hardened provision_agency_manifest_atomic RPC
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_agency_manifest_atomic(
    p_manifest JSONB,
    p_is_synthetic BOOLEAN DEFAULT FALSE,
    p_rehearsal_run_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_agency_slug TEXT;
    v_agency_name TEXT;
    v_agency_status TEXT;
    v_agency_id UUID;
    v_existing_agency_id UUID;
    v_existing_fixture_run_id UUID;
    v_domain RECORD;
    v_dom_hostname TEXT;
    v_dom_is_primary BOOLEAN;
    v_dom_ssl TEXT;
    v_existing_domain_agency_id UUID;
    v_course RECORD;
    v_course_code TEXT;
    v_v5_course_id UUID;
    v_ex_course_id UUID;
    v_ex_v5_lesson_id UUID;
    v_principal RECORD;
    v_p_email TEXT;
    v_p_role TEXT;
    v_p_name TEXT;
    v_p_user_id UUID;
    v_actual_auth_email TEXT;
    v_bank RECORD;
    v_bank_id UUID;
    v_offering RECORD;
    v_off_slug TEXT;
    v_off_title TEXT;
    v_off_desc TEXT;
    v_off_thumb TEXT;
    v_off_price BIGINT;
    v_off_sale BIGINT;
    v_off_pub BOOLEAN;
    v_off_order INT;
    v_offering_id UUID;
    v_offering_item_id UUID;
    v_item RECORD;
    v_item_course_id UUID;
    v_ui_brand TEXT;
    v_ui_storefront TEXT;
    v_ui_checkout TEXT;
    v_ui_admin TEXT;
    v_ui_learner TEXT;
    v_ui_learning TEXT;
    v_ui_homework TEXT;
    v_ui_logo TEXT;
    v_ui_favicon TEXT;
    v_ui_tokens JSONB;
    v_ui_flags JSONB;
    v_test_guard_ok BOOLEAN := FALSE;
    v_environment_fingerprint TEXT;
    v_current_release_id UUID;
    v_release_snapshot JSONB;
    v_manifest_course JSONB;
    v_item_code TEXT;
    v_item_supplied_id UUID;
    v_manifest_v5_course_id UUID;
    v_existing_cc_id UUID;
    v_existing_cc_course_id UUID;
    v_existing_lesson_v5_id UUID;
BEGIN
    -- 1. Extract and validate agency metadata
    v_agency_slug := lower(trim(p_manifest->'agency'->>'slug'));
    v_agency_name := trim(p_manifest->'agency'->>'name');
    v_agency_status := coalesce(p_manifest->'agency'->>'status', 'active');

    IF v_agency_slug IS NULL OR v_agency_slug = '' THEN
        RAISE EXCEPTION 'Agency slug is required';
    END IF;
    IF v_agency_name IS NULL OR v_agency_name = '' THEN
        RAISE EXCEPTION 'Agency name is required';
    END IF;

    -- Synthetic operations are permitted only on an isolated DB that has a
    -- test-only guard created by the test harness. Production/Main does not
    -- receive this guard from migrations, so synthetic operations fail closed.
    IF p_is_synthetic = TRUE THEN
        IF p_rehearsal_run_id IS NULL THEN
            RAISE EXCEPTION 'rehearsal_run_id is required for synthetic fixture provisioning';
        END IF;
        IF to_regclass('public.__pre_m0c_test_target_guard') IS NULL THEN
            RAISE EXCEPTION 'trusted_test_target_required: synthetic provisioning denied without isolated test-target guard';
        END IF;
        EXECUTE 'SELECT environment_fingerprint FROM public.__pre_m0c_test_target_guard WHERE run_id = $1 LIMIT 1'
          INTO v_environment_fingerprint
          USING p_rehearsal_run_id;
        IF v_environment_fingerprint IS NULL OR btrim(v_environment_fingerprint) = '' THEN
            RAISE EXCEPTION 'trusted_test_target_required: no matching test-target guard for run_id %', p_rehearsal_run_id;
        END IF;
    END IF;

    -- 2. Concurrency Lock: Deterministic transaction-level advisory lock on normalized slug
    PERFORM pg_advisory_xact_lock(hashtext('agency_provision:' || v_agency_slug));

    -- 3. Check existing agency
    SELECT id INTO v_existing_agency_id FROM public.agencies WHERE slug = v_agency_slug;

    -- 4. FIX 4 & 4B: Synthetic Marker & Authority Safety
    IF v_existing_agency_id IS NOT NULL THEN
        SELECT run_id INTO v_existing_fixture_run_id 
        FROM public.agency_test_fixtures 
        WHERE agency_id = v_existing_agency_id;

        -- 4A: Generic non-synthetic APPLY against an existing synthetic fixture: FAIL CLOSED
        IF p_is_synthetic = FALSE AND v_existing_fixture_run_id IS NOT NULL THEN
            RAISE EXCEPTION 'synthetic_fixture_conflict: Generic non-synthetic apply cannot target active synthetic test fixture agency %', v_agency_slug;
        END IF;

        -- 4B: Existing non-synthetic agency cannot be converted to synthetic test fixture
        IF p_is_synthetic = TRUE AND v_existing_fixture_run_id IS NULL THEN
            RAISE EXCEPTION 'retroactive_synthetic_forbidden: Existing normal agency % cannot be converted to a synthetic test fixture', v_agency_slug;
        END IF;

        -- 4C: Existing synthetic fixture run_id cannot be changed
        IF p_is_synthetic = TRUE AND v_existing_fixture_run_id IS NOT NULL AND v_existing_fixture_run_id <> p_rehearsal_run_id THEN
            RAISE EXCEPTION 'rehearsal_run_id_mismatch: Existing synthetic fixture has run_id % which cannot be changed to %', v_existing_fixture_run_id, p_rehearsal_run_id;
        END IF;
    END IF;

    -- 5. FIX 1: Domain Ownership Lock & Collision Check BEFORE ANY WRITE
    -- Hostnames must be checked with row-level locks. If owned by another agency, FAIL CLOSED immediately.
    FOR v_domain IN SELECT * FROM jsonb_array_elements(p_manifest->'domains') LOOP
        v_dom_hostname := lower(trim(v_domain.value->>'hostname'));
        IF v_dom_hostname IS NOT NULL AND v_dom_hostname <> '' THEN
            SELECT agency_id INTO v_existing_domain_agency_id
            FROM public.agency_domains
            WHERE hostname = v_dom_hostname
            FOR UPDATE;

            IF v_existing_domain_agency_id IS NOT NULL AND (v_existing_agency_id IS NULL OR v_existing_domain_agency_id <> v_existing_agency_id) THEN
                RAISE EXCEPTION 'domain_ownership_conflict: Hostname % is already owned by agency %', v_dom_hostname, v_existing_domain_agency_id;
            END IF;
        END IF;
    END LOOP;

    -- 6. Canonical Course Mapping Conflict Check: cannot rewrite shared canonical courses
    IF p_manifest->'learning'->'courses' IS NOT NULL THEN
        FOR v_course IN SELECT * FROM jsonb_array_elements(p_manifest->'learning'->'courses') LOOP
            v_course_code := trim(v_course.value->>'code');
            v_v5_course_id := (v_course.value->>'course_id')::uuid;
            IF v_v5_course_id IS NOT NULL THEN
                SELECT course_id INTO v_ex_course_id FROM public.canonical_courses WHERE code = v_course_code;
                IF v_ex_course_id IS NOT NULL AND v_ex_course_id <> v_v5_course_id THEN
                    RAISE EXCEPTION 'CONFLICT: Conflicting canonical course mapping for %', v_course_code;
                END IF;
            END IF;
        END LOOP;
    END IF;

    -- 7. FIX 2: Defensive Principal Identity Match Check
    -- If both email and user_id are supplied, require exact match in auth.users
    IF p_manifest->'principals' IS NOT NULL THEN
        FOR v_principal IN SELECT * FROM jsonb_array_elements(p_manifest->'principals') LOOP
            v_p_email := lower(trim(coalesce(v_principal.value->>'email', '')));
            IF v_principal.value->>'user_id' IS NOT NULL AND v_p_email <> '' THEN
                v_p_user_id := (v_principal.value->>'user_id')::uuid;
                SELECT lower(email) INTO v_actual_auth_email FROM auth.users WHERE id = v_p_user_id;
                IF v_actual_auth_email IS NULL THEN
                    RAISE EXCEPTION 'NOT_READY: Principal user_id % does not exist in auth.users', v_p_user_id;
                END IF;
                IF v_actual_auth_email <> v_p_email THEN
                    RAISE EXCEPTION 'identity_mismatch: Principal user_id % has email % which does not match manifest email %', v_p_user_id, v_actual_auth_email, v_p_email;
                END IF;
            ELSIF v_p_email <> '' THEN
                SELECT id INTO v_p_user_id FROM auth.users WHERE lower(email) = v_p_email;
                IF v_p_user_id IS NULL THEN
                    RAISE EXCEPTION 'NOT_READY: Principal % does not exist in auth.users', v_p_email;
                END IF;
            ELSIF v_principal.value->>'user_id' IS NOT NULL THEN
                v_p_user_id := (v_principal.value->>'user_id')::uuid;
                SELECT id INTO v_p_user_id FROM auth.users WHERE id = v_p_user_id;
                IF v_p_user_id IS NULL THEN
                    RAISE EXCEPTION 'NOT_READY: Principal user_id % does not exist in auth.users', v_principal.value->>'user_id';
                END IF;
            ELSE
                RAISE EXCEPTION 'NOT_READY: Principal requires valid email or user_id';
            END IF;
        END LOOP;
    END IF;

    -- 7B. Complete manifest reference preflight BEFORE the first tenant write.
    -- Canonical provisioning identifier contract: canonical_course_code is required.
    IF p_manifest->'learning'->'courses' IS NOT NULL THEN
        FOR v_course IN SELECT * FROM jsonb_array_elements(p_manifest->'learning'->'courses') LOOP
            v_course_code := trim(v_course.value->>'code');
            v_manifest_v5_course_id := NULLIF(v_course.value->>'course_id','')::uuid;
            IF v_course_code IS NULL OR v_course_code = '' OR v_manifest_v5_course_id IS NULL THEN
                RAISE EXCEPTION 'NOT_READY: every learning course requires code and course_id';
            END IF;

            SELECT id, course_id
              INTO v_existing_cc_id, v_existing_cc_course_id
            FROM public.canonical_courses
            WHERE code = v_course_code;

            IF v_existing_cc_id IS NOT NULL
               AND v_existing_cc_course_id IS NOT NULL
               AND v_existing_cc_course_id <> v_manifest_v5_course_id THEN
                RAISE EXCEPTION 'canonical_course_mapping_conflict: course % maps to %, expected %',
                    v_course_code, v_existing_cc_course_id, v_manifest_v5_course_id;
            END IF;

            SELECT published_release_id
              INTO v_current_release_id
            FROM public.v5_course_configs
            WHERE course_id = v_manifest_v5_course_id
              AND status = 'published';

            IF v_current_release_id IS NULL THEN
                RAISE EXCEPTION 'NOT_READY: V5 course % has no current published release', v_manifest_v5_course_id;
            END IF;

            SELECT snapshot
              INTO v_release_snapshot
            FROM public.v5_releases
            WHERE id = v_current_release_id
              AND course_id = v_manifest_v5_course_id
              AND status = 'published';

            IF v_release_snapshot IS NULL THEN
                RAISE EXCEPTION 'NOT_READY: published V5 release % is missing or invalid', v_current_release_id;
            END IF;

            IF v_course.value->'lessons' IS NOT NULL THEN
                FOR v_item IN SELECT * FROM jsonb_array_elements(v_course.value->'lessons') LOOP
                    IF NULLIF(v_item.value->>'v5_lesson_id','') IS NULL THEN
                        RAISE EXCEPTION 'NOT_READY: lesson % has no v5_lesson_id', coalesce(v_item.value->>'title','unknown');
                    END IF;
                    IF NOT EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements(coalesce(v_release_snapshot->'lessons','[]'::jsonb)) rel_lesson
                        WHERE rel_lesson->>'id' = v_item.value->>'v5_lesson_id'
                    ) THEN
                        RAISE EXCEPTION 'NOT_READY: v5_lesson_id % is not in current published release %',
                            v_item.value->>'v5_lesson_id', v_current_release_id;
                    END IF;

                    IF v_existing_cc_id IS NOT NULL THEN
                        SELECT v5_lesson_id
                          INTO v_existing_lesson_v5_id
                        FROM public.canonical_lessons
                        WHERE canonical_course_id = v_existing_cc_id
                          AND sort_order = coalesce((v_item.value->>'sort_order')::int, 1);

                        IF v_existing_lesson_v5_id IS NOT NULL
                           AND v_existing_lesson_v5_id <> (v_item.value->>'v5_lesson_id')::uuid THEN
                            RAISE EXCEPTION 'canonical_lesson_mapping_conflict: course % sort_order % maps to %, expected %',
                                v_course_code,
                                coalesce((v_item.value->>'sort_order')::int, 1),
                                v_existing_lesson_v5_id,
                                (v_item.value->>'v5_lesson_id')::uuid;
                        END IF;
                    END IF;
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    IF p_manifest->'offerings' IS NOT NULL THEN
        FOR v_offering IN SELECT * FROM jsonb_array_elements(p_manifest->'offerings') LOOP
            IF v_offering.value->'items' IS NULL
               OR jsonb_array_length(v_offering.value->'items') = 0 THEN
                RAISE EXCEPTION 'NOT_READY: offering % requires at least one canonical course item',
                    coalesce(v_offering.value->>'slug','unknown');
            END IF;

            FOR v_item IN SELECT * FROM jsonb_array_elements(v_offering.value->'items') LOOP
                v_item_code := trim(v_item.value->>'canonical_course_code');
                IF v_item_code IS NULL OR v_item_code = '' THEN
                    RAISE EXCEPTION 'NOT_READY: canonical_course_code is required for every offering item';
                END IF;

                SELECT id, course_id
                  INTO v_existing_cc_id, v_existing_cc_course_id
                FROM public.canonical_courses
                WHERE code = v_item_code;

                SELECT value
                  INTO v_manifest_course
                FROM jsonb_array_elements(coalesce(p_manifest->'learning'->'courses','[]'::jsonb))
                WHERE trim(value->>'code') = v_item_code
                LIMIT 1;

                IF v_existing_cc_id IS NULL AND v_manifest_course IS NULL THEN
                    RAISE EXCEPTION 'unresolved_offering_item: canonical course code % does not exist and is not declared in manifest learning.courses',
                        v_item_code;
                END IF;

                IF NULLIF(v_item.value->>'canonical_course_id','') IS NOT NULL THEN
                    v_item_supplied_id := (v_item.value->>'canonical_course_id')::uuid;
                    IF v_existing_cc_id IS NULL OR v_item_supplied_id <> v_existing_cc_id THEN
                        RAISE EXCEPTION 'offering_item_identifier_conflict: code % and canonical_course_id % do not identify the same existing course',
                            v_item_code, v_item_supplied_id;
                    END IF;
                END IF;

                IF v_manifest_course IS NOT NULL THEN
                    v_manifest_v5_course_id := NULLIF(v_manifest_course->>'course_id','')::uuid;
                    IF v_existing_cc_course_id IS NOT NULL
                       AND v_manifest_v5_course_id IS NOT NULL
                       AND v_existing_cc_course_id <> v_manifest_v5_course_id THEN
                        RAISE EXCEPTION 'canonical_course_mapping_conflict: offering item % maps to conflicting V5 course', v_item_code;
                    END IF;
                ELSIF v_existing_cc_course_id IS NULL THEN
                    RAISE EXCEPTION 'NOT_READY: existing canonical course % has no V5 course mapping', v_item_code;
                ELSE
                    SELECT published_release_id
                      INTO v_current_release_id
                    FROM public.v5_course_configs
                    WHERE course_id = v_existing_cc_course_id
                      AND status = 'published';
                    IF v_current_release_id IS NULL OR NOT EXISTS (
                        SELECT 1 FROM public.v5_releases
                        WHERE id = v_current_release_id
                          AND course_id = v_existing_cc_course_id
                          AND status = 'published'
                    ) THEN
                        RAISE EXCEPTION 'NOT_READY: offering item course % has no valid current published V5 release', v_item_code;
                    END IF;
                END IF;
            END LOOP;
        END LOOP;
    END IF;

    -- 8. Upsert Agency Record
    IF v_existing_agency_id IS NOT NULL THEN
        UPDATE public.agencies
        SET name = v_agency_name,
            status = v_agency_status,
            updated_at = now()
        WHERE id = v_existing_agency_id
        RETURNING id INTO v_agency_id;
    ELSE
        INSERT INTO public.agencies (slug, name, status, created_at, updated_at)
        VALUES (v_agency_slug, v_agency_name, v_agency_status, now(), now())
        RETURNING id INTO v_agency_id;
    END IF;

    -- 9. Trusted synthetic fixture registration is allowed only for a NEW agency
    -- created by this transaction on a verified isolated test target.
    IF p_is_synthetic = TRUE AND v_existing_agency_id IS NULL THEN
        INSERT INTO public.agency_test_fixtures (agency_id, run_id, created_at, created_by_tool, environment_fingerprint)
        VALUES (v_agency_id, p_rehearsal_run_id, now(), 'agency-provisioner', v_environment_fingerprint);
    END IF;

    -- 10. Upsert UI Profile
    v_ui_brand := p_manifest->'ui'->>'brand_name';
    v_ui_storefront := p_manifest->'ui'->>'storefront_variant';
    v_ui_checkout := p_manifest->'ui'->>'checkout_variant';
    v_ui_admin := p_manifest->'ui'->>'admin_variant';
    v_ui_learner := p_manifest->'ui'->>'learner_variant';
    v_ui_learning := p_manifest->'ui'->>'learning_variant';
    v_ui_homework := p_manifest->'ui'->>'homework_variant';
    v_ui_logo := p_manifest->'ui'->>'logo_url';
    v_ui_favicon := p_manifest->'ui'->>'favicon_url';
    v_ui_tokens := coalesce(p_manifest->'ui'->'design_tokens', '{}'::jsonb);
    v_ui_flags := coalesce(p_manifest->'ui'->'feature_flags', '{}'::jsonb);

    IF p_is_synthetic = TRUE THEN
        v_ui_flags := v_ui_flags || jsonb_build_object('synthetic_rehearsal', true, 'rehearsal_run_id', p_rehearsal_run_id);
    END IF;

    INSERT INTO public.agency_ui_profiles (
        agency_id, brand_name, logo_url, favicon_url,
        storefront_variant, checkout_variant, admin_variant,
        learner_variant, learning_variant, homework_variant,
        design_tokens, feature_flags, updated_at
    )
    VALUES (
        v_agency_id, v_ui_brand, v_ui_logo, v_ui_favicon,
        v_ui_storefront, v_ui_checkout, v_ui_admin,
        v_ui_learner, v_ui_learning, v_ui_homework,
        v_ui_tokens, v_ui_flags, now()
    )
    ON CONFLICT (agency_id) DO UPDATE
    SET brand_name = EXCLUDED.brand_name,
        logo_url = EXCLUDED.logo_url,
        favicon_url = EXCLUDED.favicon_url,
        storefront_variant = EXCLUDED.storefront_variant,
        checkout_variant = EXCLUDED.checkout_variant,
        admin_variant = EXCLUDED.admin_variant,
        learner_variant = EXCLUDED.learner_variant,
        learning_variant = EXCLUDED.learning_variant,
        homework_variant = EXCLUDED.homework_variant,
        design_tokens = EXCLUDED.design_tokens,
        feature_flags = EXCLUDED.feature_flags,
        updated_at = now();

    -- 11. FIX 1: Safe Domain Upsert — NEVER Transfer Agency ID!
    FOR v_domain IN SELECT * FROM jsonb_array_elements(p_manifest->'domains') LOOP
        v_dom_hostname := lower(trim(v_domain.value->>'hostname'));
        v_dom_is_primary := coalesce((v_domain.value->>'is_primary')::boolean, false);
        v_dom_ssl := coalesce(v_domain.value->>'ssl_status', 'active');

        IF v_dom_hostname IS NOT NULL AND v_dom_hostname <> '' THEN
            SELECT agency_id INTO v_existing_domain_agency_id
            FROM public.agency_domains
            WHERE hostname = v_dom_hostname
            FOR UPDATE;

            IF v_existing_domain_agency_id IS NOT NULL THEN
                IF v_existing_domain_agency_id <> v_agency_id THEN
                    RAISE EXCEPTION 'domain_ownership_conflict: Hostname % is already owned by agency %', v_dom_hostname, v_existing_domain_agency_id;
                END IF;
                -- Safe idempotent update of non-authority metadata ONLY
                UPDATE public.agency_domains
                SET is_primary = v_dom_is_primary,
                    ssl_status = v_dom_ssl,
                    status = 'active'
                WHERE hostname = v_dom_hostname AND agency_id = v_agency_id;
            ELSE
                BEGIN
                    INSERT INTO public.agency_domains (agency_id, hostname, is_primary, ssl_status, status, created_at)
                    VALUES (v_agency_id, v_dom_hostname, v_dom_is_primary, v_dom_ssl, 'active', now());
                EXCEPTION WHEN unique_violation THEN
                    -- Caught concurrent insert race: re-verify ownership strictly
                    SELECT agency_id INTO v_existing_domain_agency_id
                    FROM public.agency_domains
                    WHERE hostname = v_dom_hostname
                    FOR UPDATE;

                    IF v_existing_domain_agency_id <> v_agency_id THEN
                        RAISE EXCEPTION 'domain_ownership_conflict: Hostname % was concurrently claimed by agency %', v_dom_hostname, v_existing_domain_agency_id;
                    END IF;
                END;
            END IF;
        END IF;
    END LOOP;

    -- 12. Upsert Bank Accounts
    IF p_manifest->'bank_accounts' IS NOT NULL THEN
        FOR v_bank IN SELECT * FROM jsonb_array_elements(p_manifest->'bank_accounts') LOOP
            SELECT id INTO v_bank_id
            FROM public.agency_bank_accounts
            WHERE agency_id = v_agency_id
              AND account_number = v_bank.value->>'account_number'
            LIMIT 1;

            IF v_bank_id IS NOT NULL THEN
                UPDATE public.agency_bank_accounts
                SET bank_code = v_bank.value->>'bank_code',
                    account_holder = v_bank.value->>'account_holder',
                    branch = v_bank.value->>'branch',
                    is_active = coalesce((v_bank.value->>'is_active')::boolean, true),
                    is_default = coalesce((v_bank.value->>'is_default')::boolean, false)
                WHERE agency_id = v_agency_id AND id = v_bank_id;
            ELSE
                INSERT INTO public.agency_bank_accounts (
                    agency_id, bank_code, account_number, account_holder, branch, is_active, is_default, created_at
                )
                VALUES (
                    v_agency_id,
                    v_bank.value->>'bank_code',
                    v_bank.value->>'account_number',
                    v_bank.value->>'account_holder',
                    v_bank.value->>'branch',
                    coalesce((v_bank.value->>'is_active')::boolean, true),
                    coalesce((v_bank.value->>'is_default')::boolean, false),
                    now()
                );
            END IF;
        END LOOP;
    END IF;

    -- 13. Ensure Canonical Courses and Lessons exist
    IF p_manifest->'learning'->'courses' IS NOT NULL THEN
        FOR v_course IN SELECT * FROM jsonb_array_elements(p_manifest->'learning'->'courses') LOOP
            v_course_code := trim(v_course.value->>'code');
            v_v5_course_id := (v_course.value->>'course_id')::uuid;

            INSERT INTO public.canonical_courses (code, default_title, course_id, status, created_at, updated_at)
            VALUES (v_course_code, v_course.value->>'title', v_v5_course_id, 'published', now(), now())
            ON CONFLICT (code) DO UPDATE
            SET default_title = EXCLUDED.default_title,
                course_id = coalesce(canonical_courses.course_id, EXCLUDED.course_id),
                status = 'published',
                updated_at = now()
            RETURNING id INTO v_item_course_id;

            IF v_course.value->'lessons' IS NOT NULL THEN
                FOR v_item IN SELECT * FROM jsonb_array_elements(v_course.value->'lessons') LOOP
                    -- FIX 3: Verify existing lesson mapping does not conflict
                    SELECT v5_lesson_id INTO v_ex_v5_lesson_id
                    FROM public.canonical_lessons
                    WHERE canonical_course_id = v_item_course_id
                      AND sort_order = coalesce((v_item.value->>'sort_order')::int, 1);

                    IF v_ex_v5_lesson_id IS NOT NULL AND v_ex_v5_lesson_id <> (v_item.value->>'v5_lesson_id')::uuid THEN
                        RAISE EXCEPTION 'conflict: Canonical lesson % at sort_order % already mapped to %',
                            v_item.value->>'title', (v_item.value->>'sort_order')::int, v_ex_v5_lesson_id;
                    END IF;

                    INSERT INTO public.canonical_lessons (
                        canonical_course_id, v5_lesson_id, title, sort_order, is_free_preview, created_at
                    )
                    VALUES (
                        v_item_course_id,
                        (v_item.value->>'v5_lesson_id')::uuid,
                        v_item.value->>'title',
                        coalesce((v_item.value->>'sort_order')::int, 1),
                        coalesce((v_item.value->>'is_free_preview')::boolean, false),
                        now()
                    )
                    ON CONFLICT (canonical_course_id, sort_order) DO UPDATE
                    SET v5_lesson_id = EXCLUDED.v5_lesson_id,
                        title = EXCLUDED.title;
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    -- 14. FIX 3: Upsert Offerings and Offering Items — PREFLIGHT EVERY REFERENCED ITEM
    IF p_manifest->'offerings' IS NOT NULL THEN
        FOR v_offering IN SELECT * FROM jsonb_array_elements(p_manifest->'offerings') LOOP
            v_off_slug := trim(v_offering.value->>'slug');
            v_off_title := v_offering.value->>'display_title';
            v_off_desc := v_offering.value->>'display_description';
            v_off_thumb := v_offering.value->>'thumbnail_url';
            v_off_price := (v_offering.value->>'price_vnd')::bigint;
            v_off_sale := (v_offering.value->>'sale_price_vnd')::bigint;
            v_off_pub := coalesce((v_offering.value->>'is_published')::boolean, true);
            v_off_order := coalesce((v_offering.value->>'sort_order')::int, 1);

            INSERT INTO public.agency_offerings (
                agency_id, slug, display_title, display_description, thumbnail_url,
                price_vnd, sale_price_vnd, is_published, sort_order, created_at, updated_at
            )
            VALUES (
                v_agency_id, v_off_slug, v_off_title, v_off_desc, v_off_thumb,
                v_off_price, v_off_sale, v_off_pub, v_off_order, now(), now()
            )
            ON CONFLICT (agency_id, slug) DO UPDATE
            SET display_title = EXCLUDED.display_title,
                display_description = EXCLUDED.display_description,
                thumbnail_url = EXCLUDED.thumbnail_url,
                price_vnd = EXCLUDED.price_vnd,
                sale_price_vnd = EXCLUDED.sale_price_vnd,
                is_published = EXCLUDED.is_published,
                sort_order = EXCLUDED.sort_order,
                updated_at = now()
            RETURNING id INTO v_offering_id;

            -- Offering items: EVERY item must resolve. Never silently skip.
            IF v_offering.value->'items' IS NOT NULL THEN
                FOR v_item IN SELECT * FROM jsonb_array_elements(v_offering.value->'items') LOOP
                    SELECT id INTO v_item_course_id 
                    FROM public.canonical_courses 
                    WHERE code = trim(v_item.value->>'canonical_course_code');

                    IF v_item_course_id IS NULL THEN
                        RAISE EXCEPTION 'unresolved_offering_item: Canonical course code % referenced in offering % does not exist',
                            trim(v_item.value->>'canonical_course_code'), v_off_slug;
                    END IF;

                    SELECT id INTO v_offering_item_id
                    FROM public.agency_offering_items
                    WHERE agency_id = v_agency_id
                      AND offering_id = v_offering_id
                      AND canonical_course_id = v_item_course_id
                    LIMIT 1;

                    IF v_offering_item_id IS NULL THEN
                        INSERT INTO public.agency_offering_items (
                            agency_id, offering_id, canonical_course_id, item_type, sort_order, created_at
                        )
                        VALUES (
                            v_agency_id, v_offering_id, v_item_course_id,
                            coalesce(v_item.value->>'item_type', 'canonical_course'),
                            coalesce((v_item.value->>'sort_order')::int, 1),
                            now()
                        );
                    END IF;
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    -- 15. Upsert Memberships
    IF p_manifest->'principals' IS NOT NULL THEN
        FOR v_principal IN SELECT * FROM jsonb_array_elements(p_manifest->'principals') LOOP
            v_p_email := lower(trim(coalesce(v_principal.value->>'email', '')));
            v_p_role := coalesce(v_principal.value->>'role', 'agency_owner');
            v_p_name := coalesce(v_principal.value->>'display_name', split_part(v_p_email, '@', 1));
            
            IF v_principal.value->>'user_id' IS NOT NULL THEN
                v_p_user_id := (v_principal.value->>'user_id')::uuid;
            ELSE
                SELECT id INTO v_p_user_id FROM auth.users WHERE lower(email) = v_p_email;
            END IF;

            INSERT INTO public.agency_memberships (
                agency_id, user_id, role, display_name, status, created_at, updated_at
            )
            VALUES (
                v_agency_id, v_p_user_id, v_p_role, v_p_name, 'active', now(), now()
            )
            ON CONFLICT (agency_id, user_id) DO UPDATE
            SET role = EXCLUDED.role,
                display_name = EXCLUDED.display_name,
                status = 'active',
                updated_at = now();
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'agency_id', v_agency_id,
        'slug', v_agency_slug,
        'is_synthetic', p_is_synthetic
    );
END;
$$;

-- Security lockdown: revoke from anon & authenticated, grant to service_role
REVOKE ALL ON FUNCTION public.provision_agency_manifest_atomic(JSONB, BOOLEAN, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_agency_manifest_atomic(JSONB, BOOLEAN, UUID) TO service_role;

-- -----------------------------------------------------------------------------
-- 3. Hardened deprovision_synthetic_agency_atomic RPC (Fix 6)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deprovision_synthetic_agency_atomic(
    p_agency_id UUID,
    p_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fixture_rec RECORD;
    v_agency_slug TEXT;
    v_guard_fingerprint TEXT;
BEGIN
    -- Step 0: Destructive synthetic cleanup is allowed only on an isolated
    -- test database with a matching test-only guard. Main has no guard.
    IF to_regclass('public.__pre_m0c_test_target_guard') IS NULL THEN
        RAISE EXCEPTION 'trusted_test_target_required: synthetic deprovision denied without isolated test-target guard';
    END IF;
    EXECUTE 'SELECT environment_fingerprint FROM public.__pre_m0c_test_target_guard WHERE run_id = $1 LIMIT 1'
      INTO v_guard_fingerprint
      USING p_run_id;
    IF v_guard_fingerprint IS NULL OR btrim(v_guard_fingerprint) = '' THEN
        RAISE EXCEPTION 'trusted_test_target_required: no matching test-target guard for run_id %', p_run_id;
    END IF;

    -- Step 1: Protected Agencies Check (Immunity guarantee)
    SELECT slug INTO v_agency_slug FROM public.agencies WHERE id = p_agency_id;
    IF v_agency_slug IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'agency_not_found', 'error', 'Agency does not exist');
    END IF;

    IF v_agency_slug IN ('yeunauan', 'agency-a') THEN
        RETURN jsonb_build_object('ok', false, 'code', 'protected_agency', 'error', 'Protected production agency cannot be deprovisioned');
    END IF;

    -- Step 2: Verify trusted fixture registry row
    SELECT * INTO v_fixture_rec FROM public.agency_test_fixtures WHERE agency_id = p_agency_id;
    IF v_fixture_rec.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'not_synthetic_fixture', 'error', 'Agency has no registered test fixture record (not a synthetic fixture)');
    END IF;

    IF v_fixture_rec.run_id <> p_run_id THEN
        RETURN jsonb_build_object('ok', false, 'code', 'run_id_mismatch', 'error', 'Supplied run_id does not match registered test fixture run_id');
    END IF;

    IF v_fixture_rec.environment_fingerprint <> v_guard_fingerprint THEN
        RETURN jsonb_build_object('ok', false, 'code', 'environment_mismatch', 'error', 'Fixture environment fingerprint does not match active isolated test target');
    END IF;

    -- Step 3: Atomic cascading delete of tenant resources in single transaction
    DELETE FROM public.agency_homework_submissions WHERE agency_id = p_agency_id;
    DELETE FROM public.entitlement_grants WHERE agency_id = p_agency_id;
    DELETE FROM public.student_entitlements WHERE agency_id = p_agency_id;
    DELETE FROM public.order_items WHERE agency_id = p_agency_id;
    DELETE FROM public.agency_orders WHERE agency_id = p_agency_id;
    DELETE FROM public.agency_offering_items WHERE agency_id = p_agency_id;
    DELETE FROM public.agency_offerings WHERE agency_id = p_agency_id;
    DELETE FROM public.agency_domains WHERE agency_id = p_agency_id;
    DELETE FROM public.agency_bank_accounts WHERE agency_id = p_agency_id;
    DELETE FROM public.agency_ui_profiles WHERE agency_id = p_agency_id;
    DELETE FROM public.agency_memberships WHERE agency_id = p_agency_id;
    DELETE FROM public.agency_test_fixtures WHERE agency_id = p_agency_id;
    DELETE FROM public.agencies WHERE id = p_agency_id;

    RETURN jsonb_build_object('ok', true, 'code', 'deprovisioned', 'agency_id', p_agency_id, 'slug', v_agency_slug);
END;
$$;

REVOKE ALL ON FUNCTION public.deprovision_synthetic_agency_atomic(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deprovision_synthetic_agency_atomic(UUID, UUID) TO service_role;

-- -----------------------------------------------------------------------------
-- 4. FIX 9: Comprehensive Security Lockdown of Privileged Maintenance Functions
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.begin_v5_course_retire_purge(uuid, text, text, text, jsonb, integer, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_v5_course_retire_purge(uuid, text, text, text, jsonb, integer, bigint) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_v5_course_retire_purge(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_v5_course_retire_purge(uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.reset_student_session_guard(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_student_session_guard(text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.cleanup_student_account_risk_events(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_student_account_risk_events(integer) TO service_role;

REVOKE ALL ON FUNCTION public.cleanup_v5_clone_factory_fixture(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_v5_clone_factory_fixture(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.cleanup_v5_unreleased_draft_course(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_v5_unreleased_draft_course(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.v5_publish_release_atomic(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_publish_release_atomic(uuid, jsonb, text) TO service_role;

REVOKE ALL ON FUNCTION public.v5_replace_telegram_media_atomic(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v5_replace_telegram_media_atomic(uuid, uuid, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.claim_v5_telegram_mirror_job(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_v5_telegram_mirror_job(text) TO service_role;

REVOKE ALL ON FUNCTION public.finish_v5_telegram_mirror_job(uuid, text, boolean, text, bigint, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_v5_telegram_mirror_job(uuid, text, boolean, text, bigint, text, text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.tgcloner_apply_reconcile_snapshot(uuid, text, bigint, bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tgcloner_apply_reconcile_snapshot(uuid, text, bigint, bigint[]) TO service_role;

REVOKE ALL ON FUNCTION public.tgcloner_dispatch_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tgcloner_dispatch_tick() TO service_role;

-- Final fixture registry ACL reinforcement.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.agency_test_fixtures FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.agency_test_fixtures TO service_role;
