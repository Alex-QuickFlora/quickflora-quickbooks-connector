/**
 * The canonical data contract — the heart of the connector (#1204).
 *
 * Every Sunflower product (FloraChain, Florica, eVenta, legacy QuickFlora
 * POS) speaks QuickBooks through THESE shapes and nothing else. The core
 * (oauth / qbo-client / scheduler) never runs product SQL; the adapter never
 * talks to Intuit. Product-specific knowledge lives exclusively behind the
 * ProductAdapter interface.
 *
 * Deno-compatible: no Node APIs, no npm imports beyond supabase-js esm.
 */

/** A QBO-side account the product's books map onto. */
export interface ChartAccount {
  /** The product's own account code (e.g. gl_account.code). */
  code: string;
  /** The product's own account name. */
  name: string;
  /** Exact QBO account name this maps to (qb_account_map.qb_account). */
  qbName: string;
  /**
   * QBO AccountType, used only when ensureAccounts() has to CREATE the
   * account in QBO (e.g. "Bank", "Other Current Asset", "Income",
   * "Cost of Goods Sold", "Accounts Receivable", "Expense").
   */
  qbType: string;
}

export interface CanonicalJournalLine {
  /** References ChartAccount.code of the product's map. */
  accountCode: string;
  debit: number;
  credit: number;
  memo?: string | null;
}

export interface CanonicalJournalEntry {
  entryNo: string;
  /** ISO date YYYY-MM-DD. */
  date: string;
  memo?: string | null;
  /** What produced it in the product ("sales_order_booking", "payment", …). */
  sourceType: string;
  /** The product's primary key for the source row — the no-double-post key. */
  sourceId: string;
  lines: CanonicalJournalLine[];
}

export interface CanonicalPayment {
  paymentNo: string;
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** QBO Customer DisplayName the payment is posted against. */
  customerName: string;
  amount: number;
  /** Free-text method ("Credit Card (Stripe Connect)", "ACH", …). */
  method?: string | null;
  /** QBO account name to deposit to; omit for Undeposited Funds. */
  depositToQbAccount?: string | null;
  /**
   * Product's invoice/order reference the payment applies to. The core tries
   * to link it to a QBO Invoice by DocNumber; if none is found the payment
   * posts UNAPPLIED (valid in QBO) with the reference in PrivateNote.
   */
  appliedToRef?: string | null;
  reference?: string | null;
  /** No-double-post key (product's payment row id). */
  sourceId: string;
}

/** Everything the core needs at runtime; secrets arrive via env, never here. */
export interface ConnectorConfig {
  /** "florachain" | "florica" | "eventa" | "quickflora-pos" | … */
  product: string;
  tenantId: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  /** Where the browser lands after a successful OAuth connect. */
  postConnectRedirectUrl?: string;
  /** true → sandbox-quickbooks.api.intuit.com. */
  sandbox: boolean;
  /**
   * Fallback QBO customer for payments whose customerName doesn't exist in
   * QBO yet (e.g. "Sunflower Clearing"). Omit to fail such payments loudly.
   */
  clearingCustomerName?: string;
}

/** Row of the shared qb_connection table. */
export interface QboConnectionRow {
  product: string;
  tenant_id: string;
  realm_id: string;
  refresh_token: string;
  connected_by: string | null;
  connected_at: string;
  updated_at: string;
  sandbox: boolean;
  last_sync_at: string | null;
  last_sync_note: string | null;
}

/**
 * Row of the shared qb_sync_schedule table — mirrors the live FloraChain
 * shape (0111 + the out-of-band schedule it reconciled). next_run_at/hour_utc
 * are UTC; day_of_week (0–6) refines weekly, day_of_month (1–28) refines
 * monthly. window_days is how far back each run looks when last_run_at is
 * null (first run) — re-pushes are safe thanks to the no-double-post log.
 */
export interface QbSyncScheduleRow {
  product: string;
  tenant_id: string;
  enabled: boolean;
  frequency: "daily" | "weekly" | "monthly";
  hour_utc: number;
  day_of_week: number | null;
  day_of_month: number | null;
  push_journal: boolean;
  push_payments: boolean;
  window_days: number;
  last_run_at: string | null;
  last_run_note: string | null;
  next_run_at: string | null;
}

export interface PushFailure {
  ref: string;
  error: string;
}

export interface PushSummary {
  pushed: string[];
  skipped: string[];
  failed: PushFailure[];
}

/**
 * The product plug. One implementation per product; the core calls these and
 * nothing else. All methods are scoped to the tenant the adapter was built
 * for (see the factory signature in adapters/registry.ts).
 */
export interface ProductAdapter {
  /** The product's account → QBO account map. */
  getAccountMap(): Promise<ChartAccount[]>;
  /** Journal entries dated from..to (inclusive, ISO dates), ascending. */
  getJournalEntries(from: string, to: string): Promise<CanonicalJournalEntry[]>;
  /** Customer payments dated from..to (inclusive, ISO dates). */
  getPayments(from: string, to: string): Promise<CanonicalPayment[]>;
}

export type AdapterFactory = (cfg: ConnectorConfig) => ProductAdapter;
