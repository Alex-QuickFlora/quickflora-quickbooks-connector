# Embedding QuickBooksAdmin

One component, any Sunflower product. `QuickBooksAdmin.tsx` has no imports
beyond React + antd — copy it (or build it into your shared UI package) and
render it where your product keeps its integration settings.

## Props

| Prop | What to pass |
|---|---|
| `supabaseClient` | The product's existing supabase-js client (already configured with its URL/key/auth bridge). |
| `product` | The registry key: `"florachain"`, `"florica"`, `"eventa"`, … Must match `QBO_PRODUCT` on the deployed functions. |
| `tenantId` | The tenant whose QBO connection is being managed. |
| `functionsBaseUrl` | `https://<project-ref>.supabase.co/functions/v1` |
| `publishableKey` | The product project's publishable/anon key (sent as the `apikey` header to the functions). |
| `connectorKey` | Shared secret sent as `x-connector-key`; required for write actions (Sync Now, Retry failed, Preview, schedule saves). Demo-phase control — replaced by the user's Auth0 JWT at go-live. |

## Example (FloraChain)

```tsx
import { QuickBooksAdmin } from "./QuickBooksAdmin";
import { supabase } from "../lib/supabase";

<QuickBooksAdmin
  supabaseClient={supabase}
  product="florachain"
  tenantId={currentTenantId}
  functionsBaseUrl="https://srtiqddmuphqbltniagr.supabase.co/functions/v1"
  publishableKey={import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}
/>
```

## Prerequisites in the product

1. The connector tables exist — run `core/sql/001_new_product_tables.sql`
   and `core/sql/002_config_schedule_run.sql` as migrations
   (FloraChain: `003_florachain_upgrade.sql` instead).
2. The three edge functions are deployed to the product's project
   (`supabase-functions/`, see root README).
3. A `qb_connector_config` row for the product with the post-connect
   redirect pointing back at the page hosting this component — plus the
   hardening columns from `core/sql/004_sync_results.sql`
   (`deposit_mode`, `closing_date_mode`, `auto_create_entities`,
   `clearing_customer_name`), which the panel's Preview/Retry features rely
   on server-side.
4. RLS: the component READS `qb_sync_schedule`, `qb_sync_run` and
   `qb_push_result` through the product client (SELECT-only public policies
   per `core/sql/005_lockdown.sql`). Schedule WRITES go through the keyed
   `save-schedule` action on `qbo-api`. `qb_connection` stays service-role
   only by design; the component gets status from the `qbo-api` function.

## Panel features (and the API actions behind them)

- Connect/Disconnect — `qbo-auth-callback` start / `qbo-api` `disconnect`.
- Schedule editor — direct `qb_sync_schedule` upsert.
- **Preview** — `push-journal` + `push-payments` with `dryRun: true` over the
  chosen range; shows CREATE / SKIP / FAIL per record. Nothing is written.
- Sync now — `qbo-api` `run` (manual schedule run for this tenant).
- Sync history — `qb_sync_run`.
- **Sync results (per record)** — `qb_push_result`, with `qbo_id` rendered
  as a deep link into the QBO app.
- **Retry failed** — `qbo-api` `retry-failed` over the chosen range.

## Deep links into QuickBooks

Result rows link to `https://app(.sandbox).qbo.intuit.com/app/<entity>?txnId=<id>`.
These only resolve for a user who is logged into that exact QuickBooks
company in the same browser — otherwise Intuit shows its company picker or a
login wall. That's Intuit's behavior, not a bug.


## Theming

The component uses only antd theme tokens (no hardcoded colors). Wrap it in
your product's `<ConfigProvider theme={…}>` like any other screen.
