-- 003 — UPGRADE PATH for FloraChain's existing tables (pre-#1201 → shared
-- connector). Idempotent and defensive: FloraChain's live connection row,
-- its live daily schedule, and every existing push-log row must survive.
-- (Most of steps 1–3 already shipped as FloraChain migration 0111; this file
-- is the canonical connector-side record and adds the push-log delta that
-- 0111 did not cover.)

-- 1 ── qb_connection: key by (product, tenant), live row keeps working ────
alter table qb_connection add column if not exists product text not null default 'florachain';
alter table qb_connection drop constraint if exists qb_connection_pkey;
alter table qb_connection add primary key (product, tenant_id);
-- refresh_token stays service-role only: no policies, as before.

-- 2 ── qb_connector_config (per-product settings) ─────────────────────────
create table if not exists qb_connector_config (
  product                   text primary key,
  post_connect_redirect_url text not null,
  sandbox                   boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
insert into qb_connector_config (product, post_connect_redirect_url, sandbox)
values ('florachain', 'https://demo.florachain.com/reports/quickbooks-export?qbo=connected', true)
on conflict (product) do nothing;
alter table qb_connector_config enable row level security;
alter table qb_connector_config force row level security;
drop policy if exists read_all on qb_connector_config;
create policy read_all on qb_connector_config for select to public using (true);
grant select on qb_connector_config to anon;

-- 3 ── qb_sync_schedule / qb_sync_run (0111 already reconciled these with
-- the out-of-band live table; kept here for a complete upgrade record) ────
alter table qb_sync_schedule add column if not exists product text not null default 'florachain';
alter table qb_sync_schedule drop constraint if exists qb_sync_schedule_pkey;
alter table qb_sync_schedule add primary key (product, tenant_id);

create table if not exists qb_sync_run (
  id              bigint generated always as identity primary key,
  product         text not null default 'florachain',
  tenant_id       uuid not null,
  trigger_type    text not null default 'schedule' check (trigger_type in ('schedule','manual')),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running' check (status in ('running','ok','error')),
  entries_pushed  int not null default 0,
  payments_pushed int not null default 0,
  error           text
);
create index if not exists ix_qb_sync_run_tenant on qb_sync_run (product, tenant_id, started_at desc);

-- 4 ── qb_push_log: multi-product + payments (the 0111 delta) ─────────────
-- Existing rows all belong to FloraChain journal pushes, so the default
-- backfills them correctly.
alter table qb_push_log add column if not exists product text not null default 'florachain';
-- Widen the entity check so QBO Payment pushes can be logged too.
alter table qb_push_log drop constraint if exists qb_push_log_entity_type_check;
alter table qb_push_log add constraint qb_push_log_entity_type_check
  check (entity_type in ('journalentry','payment'));
-- Re-key the no-double-post unique to include product.
alter table qb_push_log drop constraint if exists qb_push_log_tenant_id_entity_type_source_id_key;
alter table qb_push_log drop constraint if exists qb_push_log_product_tenant_id_entity_type_sour_key;
alter table qb_push_log add constraint qb_push_log_product_tenant_id_entity_type_sour_key
  unique (product, tenant_id, entity_type, source_id);
