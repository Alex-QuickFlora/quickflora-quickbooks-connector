/**
 * Connector API key guard (security review RED 1).
 *
 * Read actions (status, trial-balance) stay open; everything that writes or
 * triggers work requires the `x-connector-key` header to match the
 * CONNECTOR_API_KEY secret. FAIL CLOSED: when the secret is unset, writes
 * are rejected outright — an unconfigured deployment must fail safe, never
 * silently open.
 *
 * This is the demo-phase control: at go-live the products' Auth0 user JWT
 * replaces it (verify_jwt on + per-user tenant checks).
 */

export const WRITE_ACTIONS = new Set([
  "push-journal",
  "push-payments",
  "push-invoices",
  "push-bills",
  "push-credit-memos",
  "retry-failed",
  "dedupe-journal",
  "run",
  "run-scheduled",
  "disconnect",
  "save-schedule",
]);

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Returns null when the request may proceed, or the Response to send back.
 * Call after parsing the action from the body.
 */
export function connectorKeyGuard(req: Request, action: string): Response | null {
  if (!WRITE_ACTIONS.has(action)) return null; // read actions stay open
  const expected = Deno.env.get("CONNECTOR_API_KEY");
  if (!expected) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "CONNECTOR_API_KEY secret is not set — connector write actions are disabled (fail closed).",
      }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
  if (req.headers.get("x-connector-key") !== expected) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing or invalid x-connector-key" }),
      { status: 401, headers: JSON_HEADERS },
    );
  }
  return null;
}
