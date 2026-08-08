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
   redirect pointing back at the page hosting this component.
4. RLS: the component reads/writes `qb_sync_schedule` and reads
   `qb_sync_run` through the product client. The shipped SQL includes
   permissive `public` policies — tighten them to your auth model.
   `qb_connection` stays service-role only by design; the component gets
   status from the `qbo-api` function.

## Theming

The component uses only antd theme tokens (no hardcoded colors). Wrap it in
your product's `<ConfigProvider theme={…}>` like any other screen.
