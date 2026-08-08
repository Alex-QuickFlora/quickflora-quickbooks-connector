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
   * Product's invoice number the payment applies to (#1224). When set, the
   * payment posts as a QBO Payment with a LinkedTxn to the matching Invoice
   * (looked up by DocNumber); when unset — or the invoice is not found — the
   * payment posts UNAPPLIED with the reference in PrivateNote.
   */
  appliedToInvoiceNo?: string | null;
  reference?: string | null;
  /** No-double-post key (product's payment row id). */
  sourceId: string;
}

export interface CanonicalInvoiceLine {
  /** QBO Item name; falls back to the generic "Services" item. */
  itemName: string;
  description?: string | null;
  qty: number;
  rate: number;
  amount: number;
}

/** #1224: a real QBO Invoice (A/R), not a journal pseudo-invoice. */
export interface CanonicalInvoice {
  invoiceNo: string;
  date: string;
  dueDate?: string | null;
  customerName: string;
  /**
   * Product's A/R account code. NOTE: QBO's v3 Invoice entity has no
   * per-invoice A/R account field — QBO posts to the company's default A/R.
   * The field travels for audit/future use; the client ignores it when
   * posting.
   */
  arAccountCode?: string | null;
  lines: CanonicalInvoiceLine[];
  /** Freight as an extra invoice line (posted against the Services item). */
  freight?: { description?: string | null; amount: number } | null;
  memo?: string | null;
  sourceId: string;
}

export interface CanonicalBillLine {
  /** Product account code → mapped QBO expense/asset account. */
  accountCode: string;
  description?: string | null;
  amount: number;
}

/** #1224: a real QBO Bill (A/P). */
export interface CanonicalBill {
  billNo: string;
  date: string;
  dueDate?: string | null;
  vendorName: string;
  lines: CanonicalBillLine[];
  memo?: string | null;
  sourceId: string;
}

/** #1224: a real QBO CreditMemo. */
export interface CanonicalCreditMemo {
  controlNo: string;
  date: string;
  customerName: string;
  lines: CanonicalInvoiceLine[];
  /** Product account code the credit posts against (via the item). */
  accountCode?: string | null;
  memo?: string | null;
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
  /** 'direct' = per-payment DepositToAccount; 'undeposited' = via Undeposited Funds + grouped daily Deposits (#1225). */
  depositMode?: "direct" | "undeposited";
  /** Closing-date guard (#1226): 'warn' flags, 'block' refuses, 'off' skips. */
  closingDateMode?: "warn" | "block" | "off";
  /** 'strict' = missing customer/vendor/account fails the record; 'auto' = create it (#1227). */
  autoCreateEntities?: "strict" | "auto";
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

/** Per-record outcome, persisted to qb_push_result (#1222). */
export interface RecordResult {
  entityType: string;
  /** Product's source row id. */
  sourceId: string;
  /** Human-facing number (entry no, invoice no, …). */
  ref: string;
  status: "ok" | "failed" | "skipped";
  qboId?: string;
  error?: string;
  /** Non-fatal flag, e.g. dated before the QBO closing date in warn mode. */
  warning?: string;
}

export interface PushSummary {
  pushed: string[];
  skipped: string[];
  failed: PushFailure[];
  /** One entry per record processed — the feed for qb_push_result. */
  results: RecordResult[];
}

/** What a dry run (#1221) would do, per record — nothing written anywhere. */
export interface DryRunLine {
  accountCode?: string;
  qbName?: string;
  qboId?: string;
  debit?: number;
  credit?: number;
  amount?: number;
  memo?: string | null;
}

export interface DryRunReport {
  dryRun: true;
  entityType: string;
  wouldCreate: Array<{ ref: string; date: string; sourceId: string; lines: DryRunLine[] }>;
  wouldSkip: Array<{ ref: string; sourceId: string; reason: string }>;
  wouldFail: Array<{ ref: string; sourceId: string; error: string }>;
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
  /** #1224 native pushes — optional per product. */
  getInvoices?(from: string, to: string): Promise<CanonicalInvoice[]>;
  getBills?(from: string, to: string): Promise<CanonicalBill[]>;
  getCreditMemos?(from: string, to: string): Promise<CanonicalCreditMemo[]>;
}

export type AdapterFactory = (cfg: ConnectorConfig) => ProductAdapter;
