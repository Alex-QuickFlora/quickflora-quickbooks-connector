-- 005 — RLS lockdown (security review RED 2).
--
-- Clients may READ the schedule, run history and push log (the admin panel
-- displays them) but never WRITE them: schedule edits go through the
-- qbo-api save-schedule action, and push/sync records are written by the
-- edge functions' service role (which bypasses RLS). This also closes the
-- forged-push-log hole — a public INSERT into qb_push_log could previously
-- mark a record "pushed" and silently exempt it from syncing.
--
-- Idempotent; safe on both new-product databases and FloraChain.

-- qb_sync_schedule: possibly created out-of-band with RLS OFF (FloraChain's
-- was). Enable + force, public SELECT only.
alter table qb_sync_schedule enable row level security;
alter table qb_sync_schedule force row level security;
drop policy if exists client_all on qb_sync_schedule;
drop policy if exists tenant_access on qb_sync_schedule;
drop policy if exists read_all on qb_sync_schedule;
create policy read_all on qb_sync_schedule for select to public using (true);

-- qb_sync_run: replace any FOR ALL policy with SELECT-only.
drop policy if exists tenant_access on qb_sync_run;
drop policy if exists read_all on qb_sync_run;
create policy read_all on qb_sync_run for select to public using (true);

-- qb_push_log: replace any FOR ALL policy with SELECT-only.
drop policy if exists tenant_isolation on qb_push_log;
drop policy if exists tenant_access on qb_push_log;
drop policy if exists read_all on qb_push_log;
create policy read_all on qb_push_log for select to public using (true);

-- qb_push_result: same — panel reads, functions write.
drop policy if exists tenant_access on qb_push_result;
drop policy if exists read_all on qb_push_result;
create policy read_all on qb_push_result for select to public using (true);
