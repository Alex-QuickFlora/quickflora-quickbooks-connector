-- 002 — per-product connector config + sync scheduling + run history,
-- for a NEW product database. Mirrors the live FloraChain shapes exactly
-- (0111). Adjust the permissive client policies to your product's auth
-- model before going to production.

-- Kills the hardcoded post-connect redirect and sandbox constants: the
-- OAuth callback resolves them per product from here, env as fallback.
create table if not exists qb_connector_config (
  product                   text primary key,
  post_connect_redirect_url text not null,
  sandbox                   boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
comment on table qb_connector_config is 'Epic #1201: per-product connector settings (redirect after OAuth, sandbox vs prod).';
alter table qb_connector_config enable row level security;
alter table qb_connector_config force row level security;
create policy read_all on qb_connector_config for select to public using (true);

-- One row per (product, tenant): when and what to sync.
create table if not exists qb_sync_schedule (
  product        text not null,
  tenant_id      text not null,
  enabled        boolean not null default true,
  frequency      text not null default 'daily' check (frequency in ('daily','weekly','monthly')),
  hour_utc       int not null default 10,
  day_of_week    int,                    -- weekly: 0–6 (Sunday first)
  day_of_month   int,                    -- monthly: clamped to 1–28
  push_journal   boolean not null default true,
  push_payments  boolean not null default false,
  window_days    int not null default 60, -- first-run lookback; re-pushes are safe (qb_push_log)
  last_run_at    timestamptz,
  last_run_note  text,
  next_run_at    timestamptz,
  updated_at     timestamptz not null default now(),
  primary key (product, tenant_id)
);
comment on table qb_sync_schedule is '#1208: sync cadence per (product, tenant). The scheduler runs rows where enabled and next_run_at <= now.';
alter table qb_sync_schedule enable row level security;
alter table qb_sync_schedule force row level security;
-- The admin UI edits schedules directly via the client; writes are
-- service-role in stricter products.
create policy client_all on qb_sync_schedule for all to public using (true) with check (true);

-- Fleet run history — one row per sync attempt per tenant. Consecutive
-- failures drive the alert hook; entries/payments pushed feed usage
-- metering for billing the add-on.
create table if not exists qb_sync_run (
  id              bigint generated always as identity primary key,
  product         text not null,
  tenant_id       text not null,
  trigger_type    text not null default 'schedule' check (trigger_type in ('schedule','manual')),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running' check (status in ('running','ok','error')),
  entries_pushed  int not null default 0,
  payments_pushed int not null default 0,
  error           text
);
create index if not exists ix_qb_sync_run_tenant on qb_sync_run (product, tenant_id, started_at desc);
alter table qb_sync_run enable row level security;
alter table qb_sync_run force row level security;
create policy read_all on qb_sync_run for select to public using (true);
