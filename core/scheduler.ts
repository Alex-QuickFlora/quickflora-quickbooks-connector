/**
 * Scheduler core (#1208): run every due qb_sync_schedule row, isolated per
 * tenant — one florist's broken token never blocks another's sync.
 *
 * For each due connection:
 *   1. mint a session (rolling refresh persists itself)
 *   2. ensure mapped accounts exist in QBO
 *   3. push journal entries and/or payments per the schedule's toggles,
 *      over the window (last_run_at → today]; first run looks back by
 *      frequency (daily 1d / weekly 7d / monthly 31d)
 *   4. record a qb_sync_run row (the entries/payments counts double as the
 *      metering feed for billing hooks)
 *   5. on 2+ consecutive failures, fire the injected alert hook — the
 *      product decides how alerts reach a human (email, webhook, …)
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { AdapterFactory, ConnectorConfig, ProductAdapter, QbSyncScheduleRow } from "./contract.ts";
import { QboClient } from "./qbo-client.ts";

export interface SchedulerHooks {
  /** 2+ consecutive failures — product wires its own email/webhook here. */
  alert?: (info: {
    product: string;
    tenantId: string;
    consecutiveFailures: number;
    error: string;
  }) => Promise<void>;
  /** Per-run metering for billing hooks. */
  meter?: (info: {
    product: string;
    tenantId: string;
    entriesPushed: number;
    paymentsPushed: number;
  }) => Promise<void>;
}

export interface SchedulerDeps {
  supabase: SupabaseClient;
  adapterFor: (product: string, tenantId: string) => ProductAdapter;
  clientId: string;
  clientSecret: string;
  hooks?: SchedulerHooks;
  /** Override "now" (testing). */
  now?: Date;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Next run time after `from`: daily = every day at hour_utc; weekly = the
 * configured day_of_week (0–6, Sunday first) at hour_utc; monthly = the
 * configured day_of_month (clamped to 1–28 so February can't skip a run).
 */
function nextRunAt(sched: QbSyncScheduleRow, from: Date): Date {
  const hour = Math.min(23, Math.max(0, sched.hour_utc ?? 0));
  const d = new Date(from);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(hour);
  if (sched.frequency === "monthly") {
    const dom = Math.min(28, Math.max(1, sched.day_of_month ?? 1));
    d.setUTCDate(dom);
    while (d <= from) {
      d.setUTCMonth(d.getUTCMonth() + 1);
      d.setUTCDate(dom);
    }
    return d;
  }
  if (sched.frequency === "weekly") {
    const dow = Math.min(6, Math.max(0, sched.day_of_week ?? 1));
    while (d <= from || d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  while (d <= from) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** Count of consecutive failed runs, newest first. */
async function consecutiveFailures(
  supabase: SupabaseClient,
  product: string,
  tenantId: string,
): Promise<number> {
  const { data } = await supabase
    .from("qb_sync_run")
    .select("status")
    .eq("product", product)
    .eq("tenant_id", tenantId)
    .order("started_at", { ascending: false })
    .limit(10);
  let n = 0;
  for (const r of data ?? []) {
    if (r.status === "error") n++;
    else break;
  }
  return n;
}

export async function runDueConnections(deps: SchedulerDeps & {
  /** Restrict to one connection (Sync Now) and mark runs as manual. */
  only?: { product: string; tenantId: string };
  triggerType?: "schedule" | "manual";
}): Promise<{
  ran: number;
  succeeded: number;
  failed: number;
}> {
  const now = deps.now ?? new Date();
  let q = deps.supabase
    .from("qb_sync_schedule")
    .select("*")
    .eq("enabled", true);
  if (deps.only) {
    q = q.eq("product", deps.only.product).eq("tenant_id", deps.only.tenantId);
  } else {
    q = q.lte("next_run_at", now.toISOString());
  }
  const { data: due, error } = await q;
  if (error) throw error;

  let succeeded = 0;
  let failed = 0;

  for (const sched of (due ?? []) as QbSyncScheduleRow[]) {
    const { product, tenant_id: tenantId } = sched;
    const startedAt = new Date();
    let status: "ok" | "error" = "ok";
    let entriesPushed = 0;
    let paymentsPushed = 0;
    let errorText: string | null = null;

    // Run row opens as 'running' so a crashed worker never looks like a
    // success; it is closed with ok/error in all paths.
    const { data: runRow } = await deps.supabase
      .from("qb_sync_run")
      .insert({
        product,
        tenant_id: tenantId,
        trigger_type: deps.triggerType ?? "schedule",
        started_at: startedAt.toISOString(),
        status: "running",
      })
      .select("id")
      .single();

    // Per-tenant isolation: everything for one connection is inside this
    // try/catch, so a failure is recorded and the loop moves on.
    try {
      const adapter = deps.adapterFor(product, tenantId);
      const client = new QboClient({
        supabase: deps.supabase,
        product,
        tenantId,
        clientId: deps.clientId,
        clientSecret: deps.clientSecret,
      });
      const session = await client.connect();

      const accountMap = await adapter.getAccountMap();
      await client.ensureAccounts(session, accountMap);

      // Re-pushes are harmless (qb_push_log blocks double-posting), so the
      // window is simply last_run_at → today, or window_days back on the
      // first run.
      const windowDays = sched.window_days ?? 60;
      const from = sched.last_run_at
        ? iso(new Date(sched.last_run_at))
        : iso(new Date(now.getTime() - windowDays * 86_400_000));
      const to = iso(now);

      if (sched.push_journal) {
        const entries = await adapter.getJournalEntries(from, to);
        const summary = await client.pushJournalEntries(session, entries, accountMap);
        entriesPushed = summary.pushed.length;
        if (summary.failed.length) {
          status = "error";
          errorText = `${summary.failed.length} journal entries failed: ${summary.failed[0].error}`;
        }
      }
      if (sched.push_payments) {
        const payments = await adapter.getPayments(from, to);
        const summary = await client.pushPayments(session, payments);
        paymentsPushed = summary.pushed.length;
        if (summary.failed.length) {
          status = "error";
          errorText = `${summary.failed.length} payments failed: ${summary.failed[0].error}`;
        }
      }
      await deps.supabase
        .from("qb_sync_schedule")
        .update({ last_run_note: `${deps.triggerType ?? "schedule"} run ${from}→${to}` })
        .eq("product", product)
        .eq("tenant_id", tenantId);
    } catch (e) {
      status = "error";
      errorText = String((e as Error).message ?? e).slice(0, 500);
    }

    const finishedAt = new Date();
    if (runRow?.id != null) {
      await deps.supabase
        .from("qb_sync_run")
        .update({
          finished_at: finishedAt.toISOString(),
          status,
          entries_pushed: entriesPushed,
          payments_pushed: paymentsPushed,
          error: errorText,
        })
        .eq("id", runRow.id);
    }
    await deps.supabase
      .from("qb_sync_schedule")
      .update({
        last_run_at: finishedAt.toISOString(),
        next_run_at: nextRunAt(sched, finishedAt).toISOString(),
      })
      .eq("product", product)
      .eq("tenant_id", tenantId);

    if (status === "ok") succeeded++;
    else failed++;

    await deps.hooks?.meter?.({ product, tenantId, entriesPushed, paymentsPushed });

    if (status === "error") {
      const streak = await consecutiveFailures(deps.supabase, product, tenantId);
      if (streak >= 2 && deps.hooks?.alert) {
        await deps.hooks.alert({
          product,
          tenantId,
          consecutiveFailures: streak,
          error: errorText ?? "unknown error",
        });
      }
    }
  }

  return { ran: (due ?? []).length, succeeded, failed };
}
