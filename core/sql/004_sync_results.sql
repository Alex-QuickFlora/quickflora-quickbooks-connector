-- 004 — connector hardening (#1221–#1227): per-record results + config modes.
-- Idempotent; every ALTER carries a default so FloraChain's live config row
-- keeps working unchanged.

-- #1222: latest sync outcome per source record. The unique key means one row
-- per record ever — a successful retry overwrites its earlier failure.
-- qb_push_log stays the no-double-post control; this table is the
-- operator-facing "what happened to record X" feed.
create table if not exists qb_push_result (
  id            bigint generated always as identity primary key,
  product       text not null,
  tenant_id     text not null,
  run_id        bigint,                 -- qb_sync_run.id when run-driven; null for ad-hoc pushes
  entity_type   text not null check (entity_type in ('journalentry','payment','invoice','bill','creditmemo','deposit')),
  source_id     text not null,
  ref           text,                   -- human-facing number (entry no, invoice no…)
  status        text not null check (status in ('ok','failed','skipped')),
  qbo_id        text,
  error         text,
  warning       text,                   -- non-fatal flag, e.g. closing-date warn mode
  created_at    timestamptz not null default now(),
  unique (product, tenant_id, entity_type, source_id)
);
create index if not exists ix_qb_push_result_run on qb_push_result (run_id);
comment on table qb_push_result is '#1222: latest push outcome per record (upserted per push). Powers the admin results list and retry-failed.';
alter table qb_push_result enable row level security;
alter table qb_push_result force row level security;
drop policy if exists read_all on qb_push_result;
create policy read_all on qb_push_result for select to public using (true);

-- #1225: payment deposit handling.
alter table qb_connector_config add column if not exists deposit_mode text not null default 'direct';
-- #1226: closing-date guard.
alter table qb_connector_config add column if not exists closing_date_mode text not null default 'warn';
-- #1227: strict vs auto-create for missing QBO entities.
alter table qb_connector_config add column if not exists auto_create_entities text not null default 'strict';
-- Fallback customer for payments whose customer does not exist in QBO.
alter table qb_connector_config add column if not exists clearing_customer_name text;

do $$ begin
  alter table qb_connector_config add constraint qb_connector_config_deposit_mode_check
    check (deposit_mode in ('direct','undeposited'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table qb_connector_config add constraint qb_connector_config_closing_date_mode_check
    check (closing_date_mode in ('warn','block','off'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table qb_connector_config add constraint qb_connector_config_auto_create_check
    check (auto_create_entities in ('strict','auto'));
exception when duplicate_object then null; end $$;
