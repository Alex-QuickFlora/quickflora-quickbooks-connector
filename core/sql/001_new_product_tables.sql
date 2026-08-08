-- 001 — connector tables for a NEW product database.
--
-- One QBO connection per (product, tenant). The refresh token is a SECRET:
-- qb_connection is service-role only — force RLS with no policies means
-- PostgREST roles see nothing; edge functions use the service role.
-- Access tokens are NOT stored (1-hour life); the functions mint one from
-- the refresh token on every call.
--
-- Shapes mirror the live FloraChain deployment (migration 0111 + the
-- reconciled out-of-band qb_sync_schedule) so behaviour is identical across
-- products.

create table if not exists qb_connection (
  product         text not null,
  tenant_id       text not null,
  realm_id        text not null,
  refresh_token   text not null,
  connected_by    text,
  connected_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sandbox         boolean not null default true,
  last_sync_at    timestamptz,
  last_sync_note  text,
  primary key (product, tenant_id)
);
comment on table qb_connection is 'QBO OAuth state per (product, tenant). refresh_token is a secret — service-role only, deliberately no policies. sandbox=true → sandbox-quickbooks.api.intuit.com.';
alter table qb_connection enable row level security;
alter table qb_connection force row level security;
-- no policies on purpose: the service role is the only reader/writer.

-- Per-source-row record of what was pushed to QBO. The unique key IS the
-- no-double-post control: re-running a push skips anything already logged.
create table if not exists qb_push_log (
  id            uuid primary key default gen_random_uuid(),
  product       text not null,
  tenant_id     text not null,
  entity_type   text not null check (entity_type in ('journalentry','payment')),
  source_id     text not null,          -- product's source row id
  qbo_id        text not null,          -- QBO-assigned Id
  sync_token    text,
  pushed_at     timestamptz not null default now(),
  unique (product, tenant_id, entity_type, source_id)
);
comment on table qb_push_log is 'Local source id -> QBO Id for everything pushed via the API. The unique key is the no-double-post control, mirroring the file-export stamps.';
alter table qb_push_log enable row level security;
alter table qb_push_log force row level security;
-- Read-only to clients so admin UIs can show "already pushed" state;
-- writes stay service-role (the edge functions).
create policy read_all on qb_push_log for select to public using (true);
