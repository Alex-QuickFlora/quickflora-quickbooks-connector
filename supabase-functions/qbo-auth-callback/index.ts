import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { handleOAuthRequest } from "../../core/oauth.ts";

/**
 * QBO OAuth wrapper — thin shell over core/oauth.ts (Epic #1201 / #1202).
 *
 *   GET ?action=start&product=<p>&tenant=<t>  → 302 to Intuit consent
 *   GET ?action=callback&code=…&realmId=…&state=… → store + redirect
 *
 * Secrets (supabase secrets): QBO_CLIENT_ID, QBO_CLIENT_SECRET.
 * Env: QBO_PRODUCT (default "florachain"), QBO_POST_CONNECT_REDIRECT and
 * QBO_SANDBOX as fallbacks when qb_connector_config has no row.
 *
 * The redirect URI registered in the Intuit app must be EXACTLY:
 *   ${SUPABASE_URL}/functions/v1/qbo-auth-callback
 */

serve(async (req) => {
  const clientId = Deno.env.get("QBO_CLIENT_ID");
  const clientSecret = Deno.env.get("QBO_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return new Response("QBO_CLIENT_ID / QBO_CLIENT_SECRET secrets are not set.", { status: 500 });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  return await handleOAuthRequest(req, {
    supabase,
    clientId,
    clientSecret,
    callbackUrl: Deno.env.get("QBO_CALLBACK_URL")
      ?? `${supabaseUrl}/functions/v1/qbo-auth-callback`,
    defaultProduct: Deno.env.get("QBO_PRODUCT") ?? "florachain",
    fallbackRedirectUrl: Deno.env.get("QBO_POST_CONNECT_REDIRECT"),
    fallbackSandbox: (Deno.env.get("QBO_SANDBOX") ?? "true") === "true",
  });
});
