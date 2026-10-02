-- SYSTEM B Agency Factory V1 foundation
-- Additive / backward-compatible. Existing Agency A rows remain untyped (surface IS NULL).
-- This migration does not provision Agency B/C and does not activate any tenant.

alter table public.agency_domains
  add column if not exists surface text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agency_domains_surface_check'
      and conrelid = 'public.agency_domains'::regclass
  ) then
    alter table public.agency_domains
      add constraint agency_domains_surface_check
      check (surface is null or surface in ('lms','commerce'));
  end if;
end $$;

create unique index if not exists ux_agency_domains_primary_surface
  on public.agency_domains (agency_id, surface)
  where surface is not null and is_primary = true and status = 'active';

create table if not exists public.agency_provisioning_runs (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  target_slug text not null,
  profile text not null
    check (profile in ('TENANT_SHELL','LEARNING_READY','COMMERCE_TEST_READY')),
  phase text not null default 'DRAFT'
    check (phase in ('DRAFT','PREPARING','READY','ACTIVE','BLOCKED')),
  manifest_version integer not null default 1 check (manifest_version > 0),
  manifest_hash text not null,
  manifest_summary jsonb not null default '{}'::jsonb,
  actor_ref text not null,
  agency_id uuid null references public.agencies(id) on delete restrict,
  provider_readiness jsonb not null default '{}'::jsonb,
  step_results jsonb not null default '{}'::jsonb,
  resource_ledger jsonb not null default '{"created":[],"reused":[]}'::jsonb,
  last_error_code text null,
  revision bigint not null default 1 check (revision > 0),
  source_lms_sha text null,
  source_commerce_sha text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agency_provisioning_runs enable row level security;
revoke all on table public.agency_provisioning_runs from public, anon, authenticated;
grant select, insert, update on table public.agency_provisioning_runs to service_role;

create index if not exists idx_agency_provisioning_runs_target
  on public.agency_provisioning_runs(target_slug, created_at desc);

-- One Factory run permanently reserves one normalized tenant slug. Retries use
-- the same run/idempotency key instead of letting another run adopt the target.
create unique index if not exists ux_agency_provisioning_runs_target_slug
  on public.agency_provisioning_runs(target_slug);

create or replace function public.resolve_agency_domain(p_hostname text)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'found', true,
    'agency_id', a.id,
    'agency_slug', a.slug,
    'agency_name', a.name,
    'agency_status', a.status,
    'domain_id', d.id,
    'hostname', d.hostname,
    'surface', d.surface,
    'is_primary', d.is_primary,
    'ssl_status', d.ssl_status,
    'domain_status', d.status
  )
  from public.agency_domains d
  join public.agencies a on a.id = d.agency_id
  where d.hostname = lower(trim(p_hostname))
    and d.status = 'active'
    and d.ssl_status = 'active'
    and a.status = 'active'
  limit 1;
$function$;

revoke all on function public.resolve_agency_domain(text) from public;
grant execute on function public.resolve_agency_domain(text) to anon, authenticated, service_role;

create or replace function public.provision_agency_factory_v1_atomic(
  p_run_id uuid,
  p_expected_revision bigint,
  p_manifest jsonb,
  p_manifest_hash text,
  p_profile text,
  p_actor_ref text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_run public.agency_provisioning_runs%rowtype;
  v_staged jsonb;
  v_engine_manifest jsonb;
  v_offerings jsonb;
  v_result jsonb;
  v_agency_id uuid;
  v_slug text;
  v_owned_slug text;
  v_existing_target_id uuid;
  v_domain jsonb;
  v_surface text;
  v_lms_count int;
  v_commerce_count int;
  v_domain_distinct int;
  v_course jsonb;
  v_course_code text;
  v_v5_course_id uuid;
  v_canonical_id uuid;
  v_existing_course_id uuid;
  v_published_release_id uuid;
  v_lesson jsonb;
  v_lesson_id uuid;
begin
  if p_run_id is null
     or p_expected_revision is null
     or p_manifest is null
     or p_manifest_hash is null
     or btrim(p_manifest_hash) = '' then
    raise exception 'factory_invalid_apply: run, revision, manifest and manifest hash are required';
  end if;
  if p_profile not in ('TENANT_SHELL','LEARNING_READY','COMMERCE_TEST_READY') then
    raise exception 'factory_invalid_profile: %', p_profile;
  end if;

  select * into v_run
  from public.agency_provisioning_runs
  where id = p_run_id
  for update;

  if not found then
    raise exception 'factory_run_not_found: %', p_run_id;
  end if;
  if v_run.revision <> p_expected_revision then
    raise exception 'factory_stale_revision';
  end if;
  if v_run.manifest_hash <> p_manifest_hash or v_run.profile <> p_profile then
    raise exception 'factory_manifest_revision_mismatch';
  end if;
  if v_run.actor_ref <> p_actor_ref then
    raise exception 'factory_actor_mismatch';
  end if;

  v_slug := lower(btrim(p_manifest->'agency'->>'slug'));
  if v_slug is null or v_slug = '' or v_slug <> v_run.target_slug then
    raise exception 'factory_target_mismatch';
  end if;

  -- Successful prior apply is idempotent only for the exact agency recorded by
  -- this run. Never call the generic upsert engine again on retry.
  if v_run.agency_id is not null then
    select slug into v_owned_slug
    from public.agencies
    where id = v_run.agency_id
    for update;

    if v_owned_slug is null or v_owned_slug <> v_run.target_slug then
      raise exception 'factory_target_ownership_mismatch';
    end if;

    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'run_id', v_run.id,
      'agency_id', v_run.agency_id,
      'slug', v_run.target_slug,
      'phase', v_run.phase,
      'revision', v_run.revision
    );
  end if;

  if v_run.phase not in ('DRAFT','BLOCKED') then
    raise exception 'factory_apply_phase_invalid';
  end if;

  if jsonb_typeof(p_manifest->'domains') <> 'array'
     or jsonb_array_length(p_manifest->'domains') <> 2 then
    raise exception 'factory_requires_exactly_two_typed_hosts';
  end if;

  select
    count(*) filter (where lower(btrim(value->>'surface')) = 'lms'),
    count(*) filter (where lower(btrim(value->>'surface')) = 'commerce'),
    count(distinct lower(btrim(value->>'hostname')))
  into v_lms_count, v_commerce_count, v_domain_distinct
  from jsonb_array_elements(p_manifest->'domains');

  if v_lms_count <> 1 or v_commerce_count <> 1 or v_domain_distinct <> 2 then
    raise exception 'factory_requires_one_lms_and_one_commerce_host';
  end if;

  if jsonb_typeof(p_manifest->'principals') <> 'array'
     or jsonb_array_length(p_manifest->'principals') < 1 then
    raise exception 'factory_principal_required';
  end if;

  if p_profile in ('LEARNING_READY','COMMERCE_TEST_READY')
     and (jsonb_typeof(p_manifest->'learning'->'courses') <> 'array'
          or jsonb_array_length(p_manifest->'learning'->'courses') < 1) then
    raise exception 'factory_learning_profile_requires_content';
  end if;

  if p_profile = 'COMMERCE_TEST_READY' then
    if jsonb_typeof(p_manifest->'bank_accounts') <> 'array'
       or jsonb_array_length(p_manifest->'bank_accounts') < 1 then
      raise exception 'factory_commerce_profile_requires_bank';
    end if;
    if jsonb_typeof(p_manifest->'offerings') <> 'array'
       or jsonb_array_length(p_manifest->'offerings') < 1 then
      raise exception 'factory_commerce_profile_requires_offering';
    end if;
  end if;

  -- Serialize Factory runs and also acquire the exact legacy atomic-engine slug
  -- lock before the create-only target check. This closes the race where a
  -- non-Factory provisioner could create the slug between this check and the
  -- delegated engine call.
  perform pg_advisory_xact_lock(hashtext('agency_factory_v1:' || v_slug));
  perform pg_advisory_xact_lock(hashtext('agency_provision:' || v_slug));

  select id into v_existing_target_id
  from public.agencies
  where slug = v_slug
  for update;

  if v_existing_target_id is not null then
    raise exception 'factory_target_already_exists';
  end if;

  -- Factory V1 only BINDS already prepared canonical content. It must never
  -- rewrite shared canonical course/lesson metadata used by Agency A.
  if jsonb_typeof(p_manifest->'learning'->'courses') = 'array' then
    for v_course in select value from jsonb_array_elements(p_manifest->'learning'->'courses') loop
      v_course_code := btrim(v_course->>'code');
      v_v5_course_id := nullif(v_course->>'course_id','')::uuid;
      if v_course_code is null or v_course_code = '' or v_v5_course_id is null then
        raise exception 'factory_prepared_content_reference_invalid';
      end if;

      select id, course_id
        into v_canonical_id, v_existing_course_id
      from public.canonical_courses
      where code = v_course_code;

      if v_canonical_id is null then
        raise exception 'factory_prepared_canonical_course_required: %', v_course_code;
      end if;
      if v_existing_course_id is distinct from v_v5_course_id then
        raise exception 'factory_canonical_course_mapping_conflict: %', v_course_code;
      end if;

      select published_release_id
        into v_published_release_id
      from public.v5_course_configs
      where course_id = v_v5_course_id
        and status = 'published';

      if v_published_release_id is null or not exists (
        select 1
        from public.v5_releases
        where id = v_published_release_id
          and course_id = v_v5_course_id
          and status = 'published'
      ) then
        raise exception 'factory_prepared_v5_release_required: %', v_course_code;
      end if;

      if jsonb_typeof(v_course->'lessons') = 'array' then
        for v_lesson in select value from jsonb_array_elements(v_course->'lessons') loop
          v_lesson_id := nullif(v_lesson->>'v5_lesson_id','')::uuid;
          if v_lesson_id is null or not exists (
            select 1
            from public.canonical_lessons
            where canonical_course_id = v_canonical_id
              and v5_lesson_id = v_lesson_id
          ) then
            raise exception 'factory_prepared_canonical_lesson_required: %', coalesce(v_lesson->>'v5_lesson_id','missing');
          end if;
        end loop;
      end if;
    end loop;
  end if;

  -- Force safe staged defaults server-side. Browser input cannot activate or publish.
  v_staged := jsonb_set(
    p_manifest,
    '{agency}',
    coalesce(p_manifest->'agency','{}'::jsonb) || jsonb_build_object('status','suspended'),
    true
  );

  if jsonb_typeof(v_staged->'offerings') = 'array' then
    select coalesce(jsonb_agg(value || jsonb_build_object('is_published', false)), '[]'::jsonb)
      into v_offerings
    from jsonb_array_elements(v_staged->'offerings');
    v_staged := jsonb_set(v_staged, '{offerings}', v_offerings, true);
  end if;

  -- The accepted atomic engine is reused for NEW tenant-scoped rows only.
  -- Strip learning so it cannot execute its shared canonical metadata UPSERT.
  v_engine_manifest := v_staged - 'learning';

  update public.agency_provisioning_runs
  set phase = 'PREPARING',
      last_error_code = null,
      updated_at = now(),
      revision = revision + 1
  where id = p_run_id
    and revision = p_expected_revision
    and phase in ('DRAFT','BLOCKED')
    and agency_id is null
  returning * into v_run;

  if not found then
    raise exception 'factory_stale_revision';
  end if;

  select public.provision_agency_manifest_atomic(v_engine_manifest, false, null)
    into v_result;

  v_agency_id := nullif(v_result->>'agency_id','')::uuid;
  if v_agency_id is null then
    raise exception 'factory_apply_missing_agency_id';
  end if;

  select slug into v_owned_slug
  from public.agencies
  where id = v_agency_id;
  if v_owned_slug is null or v_owned_slug <> v_slug then
    raise exception 'factory_created_target_mismatch';
  end if;

  for v_domain in select value from jsonb_array_elements(v_staged->'domains') loop
    v_surface := lower(btrim(v_domain->>'surface'));
    update public.agency_domains
       set surface = v_surface,
           is_primary = true
     where agency_id = v_agency_id
       and hostname = lower(btrim(v_domain->>'hostname'));

    if not found then
      raise exception 'factory_domain_surface_bind_failed: %', v_domain->>'hostname';
    end if;
  end loop;

  update public.agency_provisioning_runs
  set agency_id = v_agency_id,
      step_results = step_results || jsonb_build_object(
        'db_apply', jsonb_build_object('status','PASS','at',now())
      ),
      resource_ledger = jsonb_set(
        resource_ledger,
        '{agency_id}',
        to_jsonb(v_agency_id::text),
        true
      ),
      updated_at = now(),
      revision = revision + 1
  where id = p_run_id
    and revision = v_run.revision
    and phase = 'PREPARING'
    and agency_id is null
  returning * into v_run;

  if not found then
    raise exception 'factory_stale_revision';
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'run_id', p_run_id,
    'agency_id', v_agency_id,
    'slug', v_slug,
    'phase', v_run.phase,
    'revision', v_run.revision,
    'staged', true
  );
exception
  when others then
    raise;
end;
$function$;

revoke all on function public.provision_agency_factory_v1_atomic(uuid,bigint,jsonb,text,text,text) from public, anon, authenticated;
grant execute on function public.provision_agency_factory_v1_atomic(uuid,bigint,jsonb,text,text,text) to service_role;

create or replace function public.set_agency_factory_runtime_state(
  p_run_id uuid,
  p_expected_revision bigint,
  p_action text,
  p_actor_ref text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_run public.agency_provisioning_runs%rowtype;
  v_next_phase text;
  v_next_status text;
begin
  select * into v_run
  from public.agency_provisioning_runs
  where id = p_run_id
  for update;

  if not found then raise exception 'factory_run_not_found'; end if;
  if v_run.actor_ref <> p_actor_ref then raise exception 'factory_actor_mismatch'; end if;
  if v_run.revision <> p_expected_revision then raise exception 'factory_stale_revision'; end if;
  if v_run.agency_id is null then raise exception 'factory_agency_not_applied'; end if;
  if not exists (
    select 1 from public.agencies
    where id = v_run.agency_id and slug = v_run.target_slug
  ) then
    raise exception 'factory_target_ownership_mismatch';
  end if;

  if p_action in ('activate','resume') then
    if v_run.phase <> 'READY' then raise exception 'factory_run_not_ready'; end if;
    v_next_status := 'active';
    v_next_phase := 'ACTIVE';
  elsif p_action = 'suspend' then
    v_next_status := 'suspended';
    -- Suspension must never promote an unvalidated run to READY.
    v_next_phase := case
      when v_run.phase = 'ACTIVE' then 'READY'
      else v_run.phase
    end;
  else
    raise exception 'factory_invalid_runtime_action';
  end if;

  update public.agencies
     set status = v_next_status, updated_at = now()
   where id = v_run.agency_id;

  if p_action = 'suspend' then
    update public.agency_offerings
       set is_published = false, updated_at = now()
     where agency_id = v_run.agency_id;
  end if;

  update public.agency_provisioning_runs
     set phase = v_next_phase,
         updated_at = now(),
         revision = revision + 1,
         step_results = step_results || jsonb_build_object(
           'runtime_' || p_action,
           jsonb_build_object('status','PASS','at',now())
         )
   where id = p_run_id
   returning * into v_run;

  return jsonb_build_object(
    'ok', true,
    'run_id', v_run.id,
    'agency_id', v_run.agency_id,
    'phase', v_run.phase,
    'agency_status', v_next_status,
    'revision', v_run.revision
  );
end;
$function$;

revoke all on function public.set_agency_factory_runtime_state(uuid,bigint,text,text) from public, anon, authenticated;
grant execute on function public.set_agency_factory_runtime_state(uuid,bigint,text,text) to service_role;


create or replace function public.set_agency_member_status_atomic(
  p_agency_id uuid,
  p_actor_membership_id uuid,
  p_target_membership_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_agency_status text;
  v_actor public.agency_memberships%rowtype;
  v_target public.agency_memberships%rowtype;
  v_active_owner_count int;
begin
  if p_status not in ('active','suspended') then
    raise exception 'agency_member_status_invalid';
  end if;

  -- Every mutation for one tenant serializes on the same Agency row.
  select status into v_agency_status
  from public.agencies
  where id = p_agency_id
  for update;

  if v_agency_status is null then
    raise exception 'agency_not_found';
  end if;
  if v_agency_status <> 'active' then
    raise exception 'agency_not_active';
  end if;

  select * into v_actor
  from public.agency_memberships
  where id = p_actor_membership_id
    and agency_id = p_agency_id
  for update;

  if not found
     or v_actor.status <> 'active'
     or v_actor.role <> 'agency_owner' then
    raise exception 'agency_owner_required';
  end if;

  select * into v_target
  from public.agency_memberships
  where id = p_target_membership_id
    and agency_id = p_agency_id
  for update;

  if not found then
    raise exception 'agency_member_not_found';
  end if;

  if v_target.role = 'agency_owner'
     and v_target.status = 'active'
     and p_status = 'suspended' then
    -- The Agency row lock above makes this count/update decision serial.
    select count(*) into v_active_owner_count
    from public.agency_memberships
    where agency_id = p_agency_id
      and role = 'agency_owner'
      and status = 'active';

    if v_active_owner_count <= 1 then
      raise exception 'agency_last_owner_protected';
    end if;
  end if;

  update public.agency_memberships
  set status = p_status,
      updated_at = now()
  where id = v_target.id
    and agency_id = p_agency_id
  returning * into v_target;

  return jsonb_build_object(
    'ok', true,
    'id', v_target.id,
    'user_id', v_target.user_id,
    'role', v_target.role,
    'display_name', v_target.display_name,
    'status', v_target.status,
    'created_at', v_target.created_at,
    'updated_at', v_target.updated_at
  );
end;
$function$;

revoke all on function public.set_agency_member_status_atomic(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.set_agency_member_status_atomic(uuid,uuid,uuid,text) to service_role;
