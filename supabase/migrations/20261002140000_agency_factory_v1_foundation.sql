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
  v_offerings jsonb;
  v_result jsonb;
  v_agency_id uuid;
  v_slug text;
  v_domain jsonb;
  v_surface text;
  v_lms_count int;
  v_commerce_count int;
begin
  if p_run_id is null or p_manifest is null or p_manifest_hash is null or btrim(p_manifest_hash) = '' then
    raise exception 'factory_invalid_apply: run, manifest and manifest hash are required';
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

  if jsonb_typeof(p_manifest->'domains') <> 'array' then
    raise exception 'factory_domains_required';
  end if;

  select
    count(*) filter (where lower(btrim(value->>'surface')) = 'lms'),
    count(*) filter (where lower(btrim(value->>'surface')) = 'commerce')
  into v_lms_count, v_commerce_count
  from jsonb_array_elements(p_manifest->'domains');

  if v_lms_count <> 1 or v_commerce_count <> 1 then
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

  update public.agency_provisioning_runs
  set phase = 'PREPARING',
      last_error_code = null,
      updated_at = now(),
      revision = revision + 1
  where id = p_run_id;

  -- Reuse the current M0C atomic engine; all writes remain one DB transaction.
  select public.provision_agency_manifest_atomic(v_staged, false, null)
    into v_result;

  v_agency_id := nullif(v_result->>'agency_id','')::uuid;
  if v_agency_id is null then
    raise exception 'factory_apply_missing_agency_id';
  end if;

  -- Type the two Factory-managed surfaces after the reused atomic provisioner creates them.
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
  where id = p_run_id;

  return jsonb_build_object(
    'ok', true,
    'run_id', p_run_id,
    'agency_id', v_agency_id,
    'slug', v_slug,
    'phase', 'PREPARING',
    'staged', true
  );
exception
  when others then
    -- The caller records BLOCKED after a failed transaction. Do not swallow the error:
    -- keeping the transaction atomic is more important than an in-transaction error log.
    raise;
end;
$function$;

revoke all on function public.provision_agency_factory_v1_atomic(uuid,jsonb,text,text,text) from public, anon, authenticated;
grant execute on function public.provision_agency_factory_v1_atomic(uuid,jsonb,text,text,text) to service_role;

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

  if p_action in ('activate','resume') then
    if v_run.phase <> 'READY' then raise exception 'factory_run_not_ready'; end if;
    v_next_status := 'active';
    v_next_phase := 'ACTIVE';
  elsif p_action = 'suspend' then
    v_next_status := 'suspended';
    v_next_phase := case when v_run.phase = 'BLOCKED' then 'BLOCKED' else 'READY' end;
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
