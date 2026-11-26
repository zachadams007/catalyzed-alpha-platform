-- Prospective, immutable minimum-coverage candidate-universe evidence.
-- This table is deliberately private: only the service role may insert/read it.
-- It is not a replacement for daily_signals and has no UI or ranking effect.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.learning_universe_artifacts (
  artifact_id text primary key,
  artifact_sha256 text not null unique,
  source_run_id text not null unique,
  universe_id text not null unique,
  universe_definition_id text not null,
  schema_version integer not null,
  code_revision text not null,
  captured_at timestamptz not null,
  decision_at timestamptz not null,
  admissible boolean not null,
  quarantine_reasons text[] not null default '{}',
  canonical_payload text not null,
  created_at timestamptz not null default now(),
  constraint learning_universe_sha_format
    check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  constraint learning_universe_id_matches_sha
    check (artifact_id = 'sha256:' || artifact_sha256),
  constraint learning_universe_schema_v1
    check (schema_version = 1),
  constraint learning_universe_time_order
    check (captured_at <= decision_at),
  constraint learning_universe_quarantine_contract
    check (admissible = (cardinality(quarantine_reasons) = 0))
);

create index if not exists learning_universe_decision_idx
  on public.learning_universe_artifacts (decision_at desc);

alter table public.learning_universe_artifacts enable row level security;
revoke all on table public.learning_universe_artifacts
  from public, anon, authenticated, service_role;
grant select, insert on public.learning_universe_artifacts to service_role;

create or replace function public.validate_learning_universe_artifact()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  payload jsonb;
begin
  begin
    payload := new.canonical_payload::jsonb;
  exception when others then
    raise exception 'learning_universe_artifacts canonical_payload is not JSON';
  end;

  if payload ->> 'artifactType' is distinct from 'catalyzed.minimum_coverage_candidate_universe'
     or (payload ->> 'schemaVersion')::integer is distinct from new.schema_version
     or payload ->> 'sourceRunId' is distinct from new.source_run_id
     or payload ->> 'universeId' is distinct from new.universe_id
     or payload ->> 'universeDefinitionId' is distinct from new.universe_definition_id
     or payload ->> 'codeRevision' is distinct from new.code_revision
     or (payload ->> 'capturedAtISO')::timestamptz is distinct from new.captured_at
     or (payload ->> 'decisionAtISO')::timestamptz is distinct from new.decision_at
     or (payload ->> 'admissible')::boolean is distinct from new.admissible
     or payload -> 'quarantineReasons' is distinct from to_jsonb(new.quarantine_reasons) then
    raise exception 'learning_universe_artifacts columns do not match canonical_payload';
  end if;

  if encode(
       extensions.digest(
         decode('636174616c797a65642e6c6561726e696e672d756e6976657273652e763100', 'hex') ||
           convert_to(new.canonical_payload, 'UTF8'),
         'sha256'
       ),
       'hex'
     ) <> new.artifact_sha256 then
    raise exception 'learning_universe_artifacts digest does not match canonical_payload';
  end if;
  return new;
end;
$$;

drop trigger if exists learning_universe_validate_insert
  on public.learning_universe_artifacts;
create trigger learning_universe_validate_insert
  before insert on public.learning_universe_artifacts
  for each row execute function public.validate_learning_universe_artifact();

create or replace function public.reject_learning_universe_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'learning_universe_artifacts is append-only';
end;
$$;

drop trigger if exists learning_universe_reject_update_delete
  on public.learning_universe_artifacts;
create trigger learning_universe_reject_update_delete
  before update or delete on public.learning_universe_artifacts
  for each row execute function public.reject_learning_universe_mutation();
