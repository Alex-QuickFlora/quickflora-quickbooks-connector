/**
 * OAuth start/callback for Intuit, multi-tenant by design.
 *
 * Ported from FloraChain's proven qbo-auth-callback edge function; the two
 * hardcoded constants it carried — the demo tenant uuid and the post-connect
 * redirect URL — are gone. Tenant + product travel inside the OAuth `state`
 * parameter as base64url JSON, and the redirect comes from the
 * qb_connector_config table (env vars are the fallback).
 *
 *   GET ?action=start&product=florachain&tenant=<uuid>
 *       → 302 to Intuit's consent screen
 *   GET ?action=callback&code=…&realmId=…&state=…
 *       → token exchange, upsert qb_connection (product, tenant_id),
 *         302 to the product's postConnectRedirectUrl + ?qbo=connected
 *
 * NOTE (state verification): the state nonce is generated and round-tripped
 * but NOT verified against server-side storage — the proven FloraChain flow
 * was stateless too. Products that need strict CSRF validation should store
 * the nonce at start and compare at callback (the state shape has room).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";

export interface OAuthState {
  product: string;
  tenantId: string;
  nonce: string;
}

export function encodeState(state: OAuthState): string {
  // base64url(JSON) — survives the Intuit round trip untouched.
  return btoa(JSON.stringify(state)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeState(raw: string): OAuthState {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const parsed = JSON.parse(atob(b64 + pad));
  if (!parsed?.product || !parsed?.tenantId) throw new Error("invalid OAuth state");
  return parsed as OAuthState;
}

export interface OAuthDeps {
  supabase: SupabaseClient;
  clientId: string;
  clientSecret: string;
  /**
   * The exact redirect URI registered in the Intuit app. The edge runtime
   * sits behind the gateway and rewrites req.url, so this must NOT be
   * derived from the request — pass `${SUPABASE_URL}/functions/v1/qbo-auth-callback`.
   */
  callbackUrl: string;
  /** Default product when ?product= is absent. */
  defaultProduct: string;
  /** Fallbacks when qb_connector_config has no row for (product, tenant). */
  fallbackRedirectUrl?: string;
  fallbackSandbox?: boolean;
}

/** Per-product connector settings, table first, env as fallback. */
export async function resolveConnectorConfig(
  deps: Pick<OAuthDeps, "supabase" | "fallbackRedirectUrl" | "fallbackSandbox">,
  product: string,
): Promise<{ postConnectRedirectUrl?: string; sandbox: boolean }> {
  const { data } = await deps.supabase
    .from("qb_connector_config")
    .select("post_connect_redirect_url, sandbox")
    .eq("product", product)
    .maybeSingle();
  return {
    postConnectRedirectUrl: data?.post_connect_redirect_url ?? deps.fallbackRedirectUrl,
    sandbox: data?.sandbox ?? deps.fallbackSandbox ?? true,
  };
}

export function buildConsentUrl(deps: OAuthDeps, product: string, tenantId: string): string {
  const state = encodeState({ product, tenantId, nonce: crypto.randomUUID() });
  const params = new URLSearchParams({
    client_id: deps.clientId,
    scope: SCOPE,
    redirect_uri: deps.callbackUrl,
    response_type: "code",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function exchangeCode(deps: OAuthDeps, code: string) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${deps.clientId}:${deps.clientSecret}`),
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: deps.callbackUrl,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    throw new Error("token exchange failed: " + JSON.stringify(data));
  }
  return data as { refresh_token: string };
}

/** Full start/callback router — the edge wrapper is one call to this. */
export async function handleOAuthRequest(req: Request, deps: OAuthDeps): Promise<Response> {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "start";

  if (action === "start") {
    const product = url.searchParams.get("product") ?? deps.defaultProduct;
    const tenantId = url.searchParams.get("tenant");
    if (!tenantId) return new Response("missing tenant", { status: 400 });
    return Response.redirect(buildConsentUrl(deps, product, tenantId), 302);
  }

  if (action === "callback") {
    const code = url.searchParams.get("code");
    const realmId = url.searchParams.get("realmId");
    const rawState = url.searchParams.get("state");
    if (!code || !realmId || !rawState) {
      return new Response("missing code, realmId or state", { status: 400 });
    }
    const state = decodeState(rawState);
    const tokens = await exchangeCode(deps, code);
    const cfg = await resolveConnectorConfig(deps, state.product);

    const { error } = await deps.supabase.from("qb_connection").upsert({
      product: state.product,
      tenant_id: state.tenantId,
      realm_id: realmId,
      refresh_token: tokens.refresh_token,
      sandbox: cfg.sandbox,
      connected_by: "qbo-auth-callback",
      updated_at: new Date().toISOString(),
    });
    if (error) return new Response("store failed: " + error.message, { status: 500 });

    if (cfg.postConnectRedirectUrl) {
      const sep = cfg.postConnectRedirectUrl.includes("?") ? "&" : "?";
      return Response.redirect(`${cfg.postConnectRedirectUrl}${sep}qbo=connected`, 302);
    }
    return new Response("Connected to QuickBooks — you can close this tab.", { status: 200 });
  }

  return new Response("unknown action", { status: 400 });
}
