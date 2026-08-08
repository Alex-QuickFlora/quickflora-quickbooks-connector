import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { QboClient } from "../../core/qbo-client.ts";
import { runDueConnections } from "../../core/scheduler.ts";
import { pushOptionsFrom, resolvePushConfig } from "../../core/config.ts";
import { adapterFor } from "../../adapters/registry.ts";
import type { PushSummary } from "../../core/contract.ts";

/**
 * QBO API worker — thin shell over core (Epic #1201 / #1202).
 *
 *   { action: "status",        tenantId }            → connection state
 *   { action: "push-journal",  tenantId, from, to }  → push journal entries
 *   { action: "push-payments", tenantId, from, to }  → push payments
 *   { action: "push-invoices"|"push-bills"|"push-credit-memos", tenantId, from, to }
 *                                                    → native entity pushes (#1224)
 *   every push action accepts "dryRun": true         → preview, no writes (#1221)
 *   { action: "retry-failed",  tenantId, from, to }  → re-push only records whose
 *                                                      latest qb_push_result is failed (#1222)
 *   { action: "dedupe-journal", tenantId }           → delete duplicated QBO JEs
 *   { action: "trial-balance", tenantId, from?, to?} → condensed TB report
 *   { action: "run",           tenantId }            → Sync Now (manual run
 *                                                      of this tenant's schedule)
 *   { action: "disconnect",    tenantId }            → drop the connection
 *
 * Product comes from env QBO_PRODUCT (default "florachain"); the tenant
 * comes from the request body — the OAuth state carries both end-to-end.
 * Push behavior (deposit mode, closing-date guard, strict/auto) comes from
 * the product's qb_connector_config row.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const PUSH_ACTIONS: Record<string, "journal" | "payments" | "invoices" | "bills" | "creditmemos"> = {
  "push-journal": "journal",
  "push-payments": "payments",
  "push-invoices": "invoices",
  "push-bills": "bills",
  "push-credit-memos": "creditmemos",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();
    const tenantId = body.tenantId;
    if (!tenantId) return json({ ok: false, error: "tenantId is required" }, 400);

    const product = Deno.env.get("QBO_PRODUCT") ?? "florachain";
    const clientId = Deno.env.get("QBO_CLIENT_ID")!;
    const clientSecret = Deno.env.get("QBO_CLIENT_SECRET")!;
    // Deployment-level defaults; the connector core itself has no product names.
    const clearingCustomerName = Deno.env.get("QBO_CLEARING_CUSTOMER") ?? "FloraChain AR Clearing";
    const clearingVendorName = Deno.env.get("QBO_CLEARING_VENDOR") ?? "FloraChain AP Clearing";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const client = new QboClient({ supabase, product, tenantId, clientId, clientSecret, clearingCustomerName, clearingVendorName });
    const makeAdapter = (p: string, t: string) =>
      adapterFor(p)({ product: p, tenantId: t, supabaseUrl, serviceRoleKey, sandbox: true });

    if (body.action === "status") {
      return json({ ok: true, ...(await client.status()) });
    }

    if (body.action === "disconnect") {
      await client.disconnect();
      return json({ ok: true, connected: false });
    }

    const pushKind = PUSH_ACTIONS[body.action as string];
    if (pushKind) {
      const { from, to } = body;
      if (!from || !to) return json({ ok: false, error: "from and to are required" }, 400);
      const adapter = makeAdapter(product, tenantId);
      const pushCfg = await resolvePushConfig(supabase, product);
      const opts = pushOptionsFrom(pushCfg, { dryRun: body.dryRun === true });
      const accountMap = await adapter.getAccountMap();
      if (pushCfg.autoCreate && !opts.dryRun) await client.ensureAccounts(await client.connect(), accountMap);

      let summary: PushSummary | unknown;
      if (pushKind === "journal") {
        summary = await client.pushJournalEntries(await adapter.getJournalEntries(from, to), accountMap, opts);
      } else if (pushKind === "payments") {
        summary = await client.pushPayments(await adapter.getPayments(from, to), { ...opts, depositMode: pushCfg.depositMode });
      } else if (pushKind === "invoices") {
        if (!adapter.getInvoices) return json({ ok: false, error: `product "${product}" has no invoice adapter` }, 400);
        summary = await client.pushInvoices(await adapter.getInvoices(from, to), opts);
      } else if (pushKind === "bills") {
        if (!adapter.getBills) return json({ ok: false, error: `product "${product}" has no bill adapter` }, 400);
        summary = await client.pushBills(await adapter.getBills(from, to), accountMap, opts);
      } else {
        if (!adapter.getCreditMemos) return json({ ok: false, error: `product "${product}" has no credit-memo adapter` }, 400);
        summary = await client.pushCreditMemos(await adapter.getCreditMemos(from, to), opts);
      }
      const s = summary as PushSummary;
      return json({ ok: (s.failed?.length ?? 0) === 0, ...summary });
    }

    if (body.action === "retry-failed") {
      const { from, to } = body;
      if (!from || !to) return json({ ok: false, error: "from and to are required" }, 400);
      const { data: failedRows, error } = await supabase
        .from("qb_push_result")
        .select("entity_type, source_id")
        .eq("product", product)
        .eq("tenant_id", tenantId)
        .eq("status", "failed");
      if (error) throw error;
      if (!failedRows?.length) return json({ ok: true, retried: 0, message: "no failed records" });

      const adapter = makeAdapter(product, tenantId);
      const pushCfg = await resolvePushConfig(supabase, product);
      const opts = pushOptionsFrom(pushCfg, { dryRun: body.dryRun === true });
      const accountMap = await adapter.getAccountMap();
      const failedIds = (t: string) =>
        new Set(failedRows.filter((r: any) => r.entity_type === t).map((r: any) => String(r.source_id)));

      const summaries: Record<string, unknown> = {};
      const runRetry = async (type: string, items: Array<{ sourceId: string }>, push: (items: any[]) => Promise<unknown>) => {
        const ids = failedIds(type);
        if (!ids.size) return;
        const retry = items.filter((x) => ids.has(String(x.sourceId)));
        if (retry.length) summaries[type] = await push(retry as any[]);
      };
      await runRetry("journalentry", await adapter.getJournalEntries(from, to), (x) => client.pushJournalEntries(x, accountMap, opts));
      await runRetry("payment", await adapter.getPayments(from, to), (x) => client.pushPayments(x, { ...opts, depositMode: pushCfg.depositMode }));
      if (adapter.getInvoices) await runRetry("invoice", await adapter.getInvoices(from, to), (x) => client.pushInvoices(x, opts));
      if (adapter.getBills) await runRetry("bill", await adapter.getBills(from, to), (x) => client.pushBills(x, accountMap, opts));
      if (adapter.getCreditMemos) await runRetry("creditmemo", await adapter.getCreditMemos(from, to), (x) => client.pushCreditMemos(x, opts));
      return json({ ok: true, retried: failedRows.length, summaries });
    }

    if (body.action === "dedupe-journal") {
      const session = await client.connect();
      const result = await client.dedupeJournalEntries(session);
      return json({ ok: true, ...result });
    }

    if (body.action === "trial-balance") {
      const session = await client.connect();
      return json({ ok: true, accounts: await client.trialBalance(session, body.from, body.to) });
    }

    if (body.action === "run") {
      const result = await runDueConnections({
        supabase,
        adapterFor: (p, t) => makeAdapter(p, t),
        clientId,
        clientSecret,
        clearingCustomerName,
        clearingVendorName,
        only: { product, tenantId },
        triggerType: "manual",
      });
      return json({ ok: result.failed === 0, ...result });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500);
  }
});
