import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { runDueConnections } from "../../core/scheduler.ts";
import { adapterFor } from "../../adapters/registry.ts";

/**
 * Scheduled sync runner (Epic #1201 / #1208). Trigger with a Supabase
 * scheduled invocation (pg_cron → net.http_post) every 15–60 minutes; the
 * schedule rows themselves decide what is actually due.
 *
 * Alert hook: posts a JSON alert to QBO_ALERT_WEBHOOK_URL when set (wire
 * that to the product's email/Slack path); otherwise just logs. Products
 * with their own notifications table should replace the hook below.
 */

serve(async () => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const alertWebhook = Deno.env.get("QBO_ALERT_WEBHOOK_URL");

    const result = await runDueConnections({
      supabase,
      adapterFor: (product, tenantId) =>
        adapterFor(product)({
          product,
          tenantId,
          supabaseUrl,
          serviceRoleKey,
          sandbox: true,
        }),
      clientId: Deno.env.get("QBO_CLIENT_ID")!,
      clientSecret: Deno.env.get("QBO_CLIENT_SECRET")!,
      clearingCustomerName: Deno.env.get("QBO_CLEARING_CUSTOMER") ?? "FloraChain AR Clearing",
      clearingVendorName: Deno.env.get("QBO_CLEARING_VENDOR") ?? "FloraChain AP Clearing",
      hooks: {
        alert: async (info) => {
          console.error("qb-sync alert", JSON.stringify(info));
          if (alertWebhook) {
            await fetch(alertWebhook, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(info),
            });
          }
        },
      },
    });
    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message ?? e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
