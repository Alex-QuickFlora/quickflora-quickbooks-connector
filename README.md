# QuickFlora QuickBooks Connector

One QuickBooks Online connector module, sold as an add-on, usable from every
Sunflower product — FloraChain, Florica, eVenta, and (via a read-only feed)
legacy QuickFlora POS. Azure Epic #1201.

The connector talks DIRECTLY to the Intuit API. Each product plugs in an
adapter that translates its own schema into the canonical contract; the core
never knows which product it serves.

```
                 ┌──────────────────────── Sunflower product ─┐
                 │  admin-ui/QuickBooksAdmin.tsx (React+antd) │
                 └───────┬──────────────────────────▲─────────┘
            Connect/     │ supabase-js              │ status / runs
            Sync now     ▼                          │
   Intuit consent ◄── supabase-functions/ (per-product deploy)
   redirect      ┌─────  qbo-auth-callback ─┐
                 │      qbo-api             │      all three are THIN
                 │      qb-scheduler ◄──────┼─── wrappers over core/
                 └───────┬──────────────────┘
                         ▼
   ┌──────────────── core/ ────────────────┐
   │ contract.ts   canonical shapes +      │   ZERO product SQL in here.
   │               ProductAdapter iface    │   The only tables core knows:
   │ oauth.ts      start/callback, state   │   qb_connection, qb_push_log,
   │               = product+tenant        │   qb_connector_config,
   │ qbo-client.ts tokens, ensure-accounts,│   qb_sync_schedule, qb_sync_run.
   │               push journal/payments,  │
   │               trial balance           │   THE NO-DOUBLE-POST RULE:
   │ scheduler.ts  due runs, per-tenant    │   qb_push_log's unique key
   │               isolation, alerts,      │   (product, tenant, type,
   │               metering                │   source_id) — a re-push skips
   └───────┬───────────────────────────────┘   anything already logged.
           │ ProductAdapter
   ┌───────▼────────────────────────────────┐
   │ adapters/  florachain (reference)      │
   │            florica · eventa (skeleton) │
   │            quickflora-pos (MAPPING.md) │
   └────────────────────────────────────────┘
```

## Layout

- `core/` — product-blind connector library (Deno-compatible TypeScript,
  no npm deps beyond supabase-js esm). `core/sql/` holds the shared-table
  DDL products run as migrations.
- `supabase-functions/` — deployable edge-function wrappers (`qbo-auth-callback`,
  `qbo-api`, `qb-scheduler`) + the `config.toml` snippet.
- `adapters/` — one ProductAdapter per product. FloraChain is the reference.
- `admin-ui/` — the embeddable admin component + embed guide.

## Onboarding a product

1. **Intuit app**: register the redirect URI
   `https://<product-project-ref>.supabase.co/functions/v1/qbo-auth-callback`
   (must match EXACTLY — the edge gateway rewrites request URLs, so the
   function builds it from `SUPABASE_URL`, never from `req`).
2. **Secrets**: `supabase secrets set QBO_CLIENT_ID=… QBO_CLIENT_SECRET=…`
   and `QBO_PRODUCT=<product>` (defaults to `florachain`). Optional:
   `QBO_POST_CONNECT_REDIRECT`, `QBO_SANDBOX` (fallbacks when
   `qb_connector_config` has no row), `QBO_ALERT_WEBHOOK_URL` (scheduler
   failure alerts).
3. **Tables**: run `core/sql/001_new_product_tables.sql` +
   `core/sql/002_config_schedule_run.sql` as migrations.
   FloraChain instead runs `core/sql/003_florachain_upgrade.sql`
   (idempotent; the live connection row and daily schedule survive).
4. **Config row**: insert into `qb_connector_config`
   (`product`, `post_connect_redirect_url`, `sandbox`).
5. **Deploy functions**: from the product repo —
   `supabase functions deploy qbo-auth-callback qbo-api qb-scheduler`
   (the wrappers import `../../core/…`; the CLI bundles relative imports).
   Merge `supabase-functions/config.toml` into the product's config.
6. **Schedule trigger**: pg_cron → `net.http_post` to
   `/functions/v1/qb-scheduler` every 15–60 minutes.
7. **Embed the UI**: see `admin-ui/README.md`.
8. **Adapter**: copy `adapters/florachain/adapter.ts`, change the queries,
   register it in `adapters/registry.ts`.

## The no-double-post rule

Never push a source row twice. Everything the connector creates in QBO is
recorded in `qb_push_log` with a unique key on
`(product, tenant_id, entity_type, source_id)`; push paths check the log
first. Re-running any window — manual, scheduled, backfill — is always safe.
Both dedupe operations THROW on query error: a broken dedupe check stops the
run rather than silently re-posting.

## Push actions and modes (hardening, #1221–#1227)

qbo-api actions: `status`, `push-journal`, `push-payments`, `push-invoices`,
`push-bills`, `push-credit-memos`, `retry-failed`, `dedupe-journal`,
`trial-balance`, `run`, `disconnect`. Every push action accepts
`"dryRun": true` (#1221) and answers a DryRunReport (`wouldCreate` /
`wouldSkip` / `wouldFail`, with resolved QBO account names+ids) without
writing anything to QBO, `qb_push_log`, or `qb_push_result`.

Per-record outcomes are upserted into **qb_push_result** (#1222) — one row
per source record ever; a successful retry overwrites the earlier failure.
`retry-failed` re-pushes only records whose latest result row is `failed`.

`qb_connector_config` knobs (all default to the pre-hardening behavior):

| Key | Values | Story |
|---|---|---|
| `deposit_mode` | `direct` (default) / `undeposited` | #1225 — undeposited files payments under Undeposited Funds and the run closes with one grouped QBO Deposit per (date, bank account), recorded as `entity_type='deposit'` |
| `closing_date_mode` | `warn` (default) / `block` / `off` | #1226 — records dated on/before QBO's CloseBooksDate are flagged or refused |
| `auto_create_entities` | `strict` (default) / `auto` | #1227 — strict fails missing customers/vendors/accounts; auto creates them (accounts use the map's qbType) |
| `clearing_customer_name` | text | fallback customer for payments to unknown customers |

Deep links (#1223): `qboDeepLink(sandbox, entityType, qboId)` →
`https://app(.sandbox).qbo.intuit.com/app/<entity>?txnId=<id>`; the admin
panel renders every pushed qbo_id as one.


## Sandbox vs production

`qb_connection.sandbox` (set at connect time from `qb_connector_config`)
picks the base URL: `sandbox-quickbooks.api.intuit.com` vs
`quickbooks.api.intuit.com`. Test against an Intuit sandbox company first;
flip the config row and reconnect to go live. The admin panel shows an
orange SANDBOX tag whenever a sandbox company is connected.
