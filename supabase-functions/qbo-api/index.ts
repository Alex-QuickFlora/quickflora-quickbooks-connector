import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { QboClient } from "../../core/qbo-client.ts";
import { runDueConnections } from "../../core/scheduler.ts";
import { adapterFor } from "../../adapters/registry.ts";

/**
 * QBO API worker — thin shell over core (Epic #1201 / #1202).
 *
 *   { action: "status",        tenantId }            → connection state
 *   { action: "push-journal",  tenantId, from, to }  → push journal entries
 *   { action: "push-payments", tenantId, from, to }  → push payments
 *   { action: "trial-balance", tenantId, from?, to?} → condensed TB report
 *   { action: "run",           tenantId }            → Sync Now (manual run
 *                                                      of this tenant's schedule)
 *   { action: "disconnect",    tenantId }            → drop the connection
 *
 * Product comes from env QBO_PRODUCT (default "florachain"); the tenant
 * comes from the request body — the OAuth state carries both end-to-end.
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();
    const tenantId = body.tenantId;
    if (!tenantId) return json({ ok: false, error: "tenantId is required" }, 400);

    const product = Deno.env.get("QBO_PRODUCT") ?? "florachain";
    const clientId = Deno.env.get("QBO_CLIENT_ID")!;
    const clientSecret = Deno.env.get("QBO_CLIENT_SECRET")!;
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const client = new QboClient({ supabase, product, tenantId, clientId, clientSecret });

    if (body.action === "status") {
      return json({ ok: true, ...(await client.status()) });
    }

    if (body.action === "disconnect") {
      await client.disconnect();
      return json({ ok: true, connected: false });
    }

    if (body.action === "push-journal" || body.action === "push-payments") {
      const { from, to } = body;
      if (!from || !to) return json({ ok: false, error: "from and to are required" }, 400);
      const adapter = adapterFor(product)({
        product,
        tenantId,
        supabaseUrl: Deno.env.get("SUPABASE_URL")!,
        serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        sandbox: true,
      });
      const session = await client.connect();
      const accountMap = await adapter.getAccountMap();
      await client.ensureAccounts(session, accountMap);
      const summary = body.action === "push-journal"
        ? await client.pushJournalEntries(session, await adapter.getJournalEntries(from, to), accountMap)
        : await client.pushPayments(session, await adapter.getPayments(from, to));
      return json({ ok: summary.failed.length === 0, ...summary });
    }

    if (body.action === "trial-balance") {
      const session = await client.connect();
      return json({ ok: true, accounts: await client.trialBalance(session, body.from, body.to) });
    }

    if (body.action === "run") {
      const result = await runDueConnections({
        supabase,
        adapterFor: (p, t) =>
          adapterFor(p)({
            product: p,
            tenantId: t,
            supabaseUrl: Deno.env.get("SUPABASE_URL")!,
            serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
            sandbox: true,
          }),
        clientId,
        clientSecret,
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
