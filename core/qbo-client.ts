/**
 * QBO API client — token lifecycle, fetch wrapper, entity pushes, reports.
 *
 * Ported from FloraChain's proven supabase/functions/qbo-api/index.ts and
 * generalized: every call is scoped by (product, tenantId). Contains ZERO
 * product-specific SQL — the only tables touched are the connector's own
 * shared ones (qb_connection, qb_push_log, qb_push_result).
 *
 * Hardening stories covered here:
 *   #1221 dryRun — every push can report what it WOULD do, writing nothing
 *   #1222 per-record results persisted to qb_push_result (qb_push_log stays
 *         the no-double-post control for successes)
 *   #1223 qboDeepLink() — app URL for any pushed entity
 *   #1224 native Invoice / Bill / CreditMemo pushes + payment application
 *   #1225 grouped daily Deposits when deposit mode is 'undeposited'
 *   #1226 closing-date guard (warn / block / off)
 *   #1227 strict vs auto-create for missing customers/vendors/accounts/items
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  CanonicalBill,
  CanonicalCreditMemo,
  CanonicalInvoice,
  CanonicalJournalEntry,
  CanonicalPayment,
  ChartAccount,
  DryRunLine,
  DryRunReport,
  PushSummary,
  QboConnectionRow,
  RecordResult,
} from "./contract.ts";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const PROD_BASE = "https://quickbooks.api.intuit.com";
const SANDBOX_BASE = "https://sandbox-quickbooks.api.intuit.com";

export interface QboSession {
  access: string;
  realm: string;
  base: string;
  sandbox: boolean;
  connection: QboConnectionRow;
}

export interface PushOptions {
  /** #1221: report only — write nothing to QBO, qb_push_log or qb_push_result. */
  dryRun?: boolean;
  /** #1227: create missing customers/vendors/accounts/items instead of failing. */
  autoCreate?: boolean;
  /** #1226: dated-before-close handling (default 'warn'). */
  closingDateMode?: "warn" | "block" | "off";
  /** Fallback QBO customer for payments to unknown customers. */
  clearingCustomerName?: string;
  /** qb_sync_run.id to stamp onto qb_push_result rows. */
  runId?: number | null;
}

/** #1223: deep link into the QBO app for a pushed entity. */
const ENTITY_PATHS: Record<string, string> = {
  journalentry: "journal",
  invoice: "invoice",
  bill: "bill",
  creditmemo: "creditmemo",
  payment: "customerpayment",
  deposit: "deposit",
};
export function qboDeepLink(sandbox: boolean, entityType: string, qboId: string): string {
  const host = sandbox ? "https://app.sandbox.qbo.intuit.com" : "https://app.qbo.intuit.com";
  const path = ENTITY_PATHS[entityType] ?? "journal";
  return `${host}/app/${path}?txnId=${encodeURIComponent(qboId)}`;
}

/** CloseBooksDate cache: one Preferences read per connection per day (#1226). */
const closingDateCache = new Map<string, string | null>();

const GENERIC_ITEM = "Services";

export class QboClient {
  constructor(
    private deps: {
      supabase: SupabaseClient;
      product: string;
      tenantId: string;
      clientId: string;
      clientSecret: string;
      /** QBO requires an Entity on journal lines posting to AR/AP; GL-level
       * entries carry no counterparty, so these stand in. AR/AP journal
       * lines fail loudly when unset. */
      clearingCustomerName?: string;
      clearingVendorName?: string;
    },
  ) {}

  private connFilter(q: any) {
    return q.eq("product", this.deps.product).eq("tenant_id", this.deps.tenantId);
  }

  /** Load the connection row and mint a fresh access token. */
  async connect(): Promise<QboSession> {
    const { data, error } = await this.connFilter(
      this.deps.supabase.from("qb_connection").select("*"),
    ).maybeSingle();
    if (error || !data) {
      throw new Error("Not connected to QuickBooks — run the Connect flow first.");
    }
    const conn = data as QboConnectionRow;

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + btoa(`${this.deps.clientId}:${this.deps.clientSecret}`),
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: conn.refresh_token,
      }),
    });
    const tok = await res.json();
    if (!res.ok || !tok.access_token) {
      throw new Error("QBO token refresh failed — reconnect. " + JSON.stringify(tok));
    }
    // Refresh tokens roll: persist the new one or the next call breaks.
    if (tok.refresh_token && tok.refresh_token !== conn.refresh_token) {
      await this.connFilter(
        this.deps.supabase.from("qb_connection")
          .update({ refresh_token: tok.refresh_token, updated_at: new Date().toISOString() }),
      );
      conn.refresh_token = tok.refresh_token;
    }
    return {
      access: tok.access_token as string,
      realm: conn.realm_id,
      base: conn.sandbox ? SANDBOX_BASE : PROD_BASE,
      sandbox: conn.sandbox,
      connection: conn,
    };
  }

  /** Authenticated QBO v3 fetch with a useful error on failure. */
  async qbo(session: QboSession, path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${session.base}/v3/company/${session.realm}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${session.access}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) throw new Error(`QBO ${path} → ${res.status}: ${text.slice(0, 400)}`);
    return body;
  }

  /** Connection status + company name (what the admin UI shows). */
  async status(): Promise<{ connected: boolean; realm: string; sandbox: boolean; company: string | null; lastSyncAt: string | null; lastSyncNote: string | null }> {
    const session = await this.connect();
    const info = await this.qbo(session, `/query?query=${encodeURIComponent("select * from companyinfo")}`) as {
      CompanyInfo?: Array<{ CompanyName?: string }>;
    };
    return {
      connected: true,
      realm: session.realm,
      sandbox: session.sandbox,
      company: info.CompanyInfo?.[0]?.CompanyName ?? null,
      lastSyncAt: session.connection.last_sync_at,
      lastSyncNote: session.connection.last_sync_note,
    };
  }

  /** Remove the connection row (Disconnect button). */
  async disconnect(): Promise<void> {
    const { error } = await this.connFilter(
      this.deps.supabase.from("qb_connection").delete(),
    );
    if (error) throw error;
  }

  /** QBO account Name -> Id, fetched once per client and cached. */
  private accountCache: Map<string, string> | null = null;
  async accountIds(session: QboSession): Promise<Map<string, string>> {
    if (this.accountCache) return this.accountCache;
    const res = await this.qbo(
      session,
      `/query?query=${encodeURIComponent("select Id, Name from account maxresults 1000")}`,
    ) as { QueryResponse?: { Account?: Array<{ Id: string; Name: string }> } };
    const map = new Map<string, string>();
    for (const a of res.QueryResponse?.Account ?? []) map.set(a.Name, a.Id);
    this.accountCache = map;
    return map;
  }

  /**
   * Create any mapped QBO accounts that don't exist yet, so a push never
   * dies on "no QBO account X" when we could have just made it. Equivalent
   * to running the pushes with autoCreate on accounts only.
   */
  async ensureAccounts(session: QboSession, map: ChartAccount[]): Promise<{ created: string[] }> {
    const existing = await this.accountIds(session);
    const created: string[] = [];
    for (const a of map) {
      if (existing.has(a.qbName)) continue;
      // QBO allows one Opening Balance Equity account per company; any other
      // Equity account must carry an explicit sub-type or creation fails
      // with validation error 6000.
      const payload: Record<string, string> = { Name: a.qbName, AccountType: a.qbType };
      if (a.qbType === "Equity") payload.AccountSubType = "OwnersEquity";
      const res = await this.qbo(session, `/account?minorversion=73`, {
        method: "POST",
        body: JSON.stringify(payload),
      }) as { Account?: { Id?: string } };
      if (res.Account?.Id) {
        existing.set(a.qbName, res.Account.Id);
        created.push(a.qbName);
      }
    }
    return { created };
  }

  /** QBO Preferences → CloseBooksDate (ISO), cached per connection per day. */
  async getClosingDate(session: QboSession): Promise<string | null> {
    const key = `${this.deps.product}:${this.deps.tenantId}:${new Date().toISOString().slice(0, 10)}`;
    if (closingDateCache.has(key)) return closingDateCache.get(key) ?? null;
    let close: string | null = null;
    try {
      const prefs = await this.qbo(session, `/preferences`) as {
        Preferences?: { AccountingInfoPrefs?: { CloseBooksDate?: string } };
      };
      close = prefs.Preferences?.AccountingInfoPrefs?.CloseBooksDate ?? null;
    } catch {
      close = null; // preferences unreadable → no guard, pushes proceed
    }
    closingDateCache.set(key, close);
    return close;
  }

  /** #1226: null = clear; otherwise the warning/block message for this date. */
  private async closingCheck(session: QboSession, date: string, opts: PushOptions): Promise<string | null> {
    const mode = opts.closingDateMode ?? "warn";
    if (mode === "off") return null;
    const close = await this.getClosingDate(session);
    if (!close || date > close) return null;
    return `dated ${date}, on/before the QBO close date ${close}`;
  }

  // ── Entity resolution (#1227 strict/auto) ──────────────────────────────

  /** Account by mapped QBO name; auto mode creates it with the map's type. */
  private async resolveAccount(
    session: QboSession,
    qbName: string | undefined,
    qbType: string | undefined,
    opts: PushOptions,
  ): Promise<{ id?: string; error?: string }> {
    if (!qbName) return { error: "no QBO account mapped" };
    const ids = await this.accountIds(session);
    const hit = ids.get(qbName);
    if (hit) return { id: hit };
    if (!opts.autoCreate) return { error: `no QBO account "${qbName}"` };
    if (!qbType) return { error: `QBO account "${qbName}" missing and no qbType on the map to create it` };
    const created = await this.qbo(session, `/account?minorversion=73`, {
      method: "POST",
      body: JSON.stringify({ Name: qbName, AccountType: qbType }),
    }) as { Account?: { Id?: string } };
    if (!created.Account?.Id) return { error: `could not create QBO account "${qbName}"` };
    ids.set(qbName, created.Account.Id);
    return { id: created.Account.Id };
  }

  private async findByName(session: QboSession, entity: string, display: string): Promise<string | null> {
    const res = await this.qbo(
      session,
      `/query?query=${encodeURIComponent(`select Id, DisplayName from ${entity} where DisplayName = '${display.replace(/'/g, "\\'")}'`)}`,
    ) as { QueryResponse?: Record<string, Array<{ Id: string }> | undefined> };
    const rows = res.QueryResponse?.[entity === "customer" ? "Customer" : "Vendor"];
    return rows?.[0]?.Id ?? null;
  }

  private async resolveCustomer(
    session: QboSession,
    name: string,
    opts: PushOptions,
  ): Promise<{ id?: string; error?: string }> {
    const direct = await this.findByName(session, "customer", name);
    if (direct) return { id: direct };
    if (opts.autoCreate) {
      const created = await this.qbo(session, `/customer?minorversion=73`, {
        method: "POST",
        body: JSON.stringify({ DisplayName: name }),
      }) as { Customer?: { Id?: string } };
      if (created.Customer?.Id) return { id: created.Customer.Id };
      return { error: `could not create QBO customer "${name}"` };
    }
    const clearing = opts.clearingCustomerName ?? this.deps.clearingCustomerName;
    if (clearing) {
      const found = await this.findByName(session, "customer", clearing);
      if (found) return { id: found };
      // The clearing customer itself is always auto-created — it is the
      // product's chosen safety valve, not an arbitrary new entity.
      const created = await this.qbo(session, `/customer?minorversion=73`, {
        method: "POST",
        body: JSON.stringify({ DisplayName: clearing }),
      }) as { Customer?: { Id?: string } };
      if (created.Customer?.Id) return { id: created.Customer.Id };
    }
    return { error: `QBO customer "${name}" not found` };
  }

  private async resolveVendor(
    session: QboSession,
    name: string,
    opts: PushOptions,
  ): Promise<{ id?: string; error?: string }> {
    const direct = await this.findByName(session, "vendor", name);
    if (direct) return { id: direct };
    if (opts.autoCreate) {
      const created = await this.qbo(session, `/vendor?minorversion=73`, {
        method: "POST",
        body: JSON.stringify({ DisplayName: name }),
      }) as { Vendor?: { Id?: string } };
      if (created.Vendor?.Id) return { id: created.Vendor.Id };
      return { error: `could not create QBO vendor "${name}"` };
    }
    return { error: `QBO vendor "${name}" not found` };
  }

  /** Item by Name with the generic "Services" fallback (created in auto mode). */
  private async resolveItem(session: QboSession, name: string, opts: PushOptions): Promise<{ id?: string; error?: string }> {
    const find = async (n: string) => {
      const res = await this.qbo(
        session,
        `/query?query=${encodeURIComponent(`select Id from item where Name = '${n.replace(/'/g, "\\'")}'`)}`,
      ) as { QueryResponse?: { Item?: Array<{ Id: string }> } };
      return res.QueryResponse?.Item?.[0]?.Id ?? null;
    };
    const direct = await find(name);
    if (direct) return { id: direct };
    const generic = await find(GENERIC_ITEM);
    if (generic) return { id: generic };
    if (opts.autoCreate) {
      // A Service item needs an income account — use the first Income one.
      const res = await this.qbo(
        session,
        `/query?query=${encodeURIComponent("select Id from account where AccountType = 'Income' maxresults 1")}`,
      ) as { QueryResponse?: { Account?: Array<{ Id: string }> } };
      const incomeId = res.QueryResponse?.Account?.[0]?.Id;
      if (!incomeId) return { error: `no QBO item "${name}" and no Income account to create "${GENERIC_ITEM}" against` };
      const created = await this.qbo(session, `/item?minorversion=73`, {
        method: "POST",
        body: JSON.stringify({ Name: GENERIC_ITEM, Type: "Service", IncomeAccountRef: { value: incomeId } }),
      }) as { Item?: { Id?: string } };
      if (created.Item?.Id) return { id: created.Item.Id };
      return { error: `could not create generic item "${GENERIC_ITEM}"` };
    }
    return { error: `no QBO item "${name}" and no "${GENERIC_ITEM}" fallback` };
  }

  // ── Push plumbing (no-double-post + results + dry run) ─────────────────

  /** The no-double-post control: shared qb_push_log, unique per source row.
   * Both operations THROW on query error — a broken dedupe query must stop
   * the run, never silently report "not pushed yet" (that exact silent
   * failure double-posted 6 entries on 8/8 when the product column was
   * missing from qb_push_log). */
  private async alreadyPushed(entityType: string, sourceId: string): Promise<boolean> {
    const { data, error } = await this.connFilter(
      this.deps.supabase.from("qb_push_log")
        .select("id").eq("entity_type", entityType).eq("source_id", sourceId),
    );
    if (error) throw new Error(`qb_push_log dedupe check failed: ${error.message}`);
    return (data?.length ?? 0) > 0;
  }

  private async logPush(entityType: string, sourceId: string, qboId: string, syncToken: string) {
    const { error } = await this.deps.supabase.from("qb_push_log").insert({
      product: this.deps.product,
      tenant_id: this.deps.tenantId,
      entity_type: entityType,
      source_id: sourceId,
      qbo_id: qboId,
      sync_token: syncToken,
    });
    if (error) {
      throw new Error(
        `pushed ${entityType} ${sourceId} to QBO (id ${qboId}) but FAILED to record it in qb_push_log: ${error.message} — fix the log before the next run or this record will double-post`,
      );
    }
  }

  /** #1222: upsert the latest outcome per record. */
  private async recordResults(results: RecordResult[], opts: PushOptions) {
    if (opts.dryRun || !results.length) return;
    await this.deps.supabase.from("qb_push_result").upsert(
      results.map((r) => ({
        product: this.deps.product,
        tenant_id: this.deps.tenantId,
        run_id: opts.runId ?? null,
        entity_type: r.entityType,
        source_id: r.sourceId,
        ref: r.ref,
        status: r.status,
        qbo_id: r.qboId ?? null,
        error: r.error ?? null,
        warning: r.warning ?? null,
      })),
      { onConflict: "product,tenant_id,entity_type,source_id" },
    );
  }

  /**
   * Generic push runner. `build` returns the QBO entity body plus the
   * dry-run line detail, or an error string (record fails). Everything else —
   * skip-if-pushed, closing-date guard, dry-run collection, result
   * persistence — lives here so every entity type behaves identically.
   */
  private async runPush<T>(
    entityType: string,
    endpoint: string,
    responseKey: string,
    items: T[],
    meta: { ref: (x: T) => string; date: (x: T) => string; sourceId: (x: T) => string },
    build: (x: T) => Promise<{ body?: Record<string, unknown>; lines: DryRunLine[]; error?: string }>,
    opts: PushOptions,
    session: QboSession | null,
  ): Promise<PushSummary | DryRunReport> {
    const out: PushSummary = { pushed: [], skipped: [], failed: [], results: [] };
    const dry: DryRunReport = { dryRun: true, entityType, wouldCreate: [], wouldSkip: [], wouldFail: [] };

    for (const item of items) {
      const ref = meta.ref(item);
      const sourceId = meta.sourceId(item);
      const date = meta.date(item);

      if (await this.alreadyPushed(entityType, sourceId)) {
        out.skipped.push(ref);
        out.results.push({ entityType, sourceId, ref, status: "skipped" });
        dry.wouldSkip.push({ ref, sourceId, reason: "already in qb_push_log" });
        continue;
      }

      // Closing-date guard (#1226): block fails the record, warn flags it.
      let closeMsg: string | null = null;
      if (session) closeMsg = await this.closingCheck(session, date, opts);
      if (closeMsg && (opts.closingDateMode ?? "warn") === "block") {
        const error = `Refused: ${ref} is ${closeMsg} (mode=block)`;
        out.failed.push({ ref, error });
        out.results.push({ entityType, sourceId, ref, status: "failed", error });
        dry.wouldFail.push({ ref, sourceId, error });
        continue;
      }

      const built = session ? await build(item) : { lines: [], error: "no session" };
      if (built.error || !built.body) {
        const error = built.error ?? "build failed";
        out.failed.push({ ref, error });
        out.results.push({ entityType, sourceId, ref, status: "failed", error });
        dry.wouldFail.push({ ref, sourceId, error });
        continue;
      }

      if (opts.dryRun) {
        dry.wouldCreate.push({ ref, date, sourceId, lines: built.lines });
        continue;
      }

      try {
        const created = await this.qbo(session!, `${endpoint}?minorversion=73`, {
          method: "POST",
          body: JSON.stringify(built.body),
        }) as Record<string, { Id?: string; SyncToken?: string } | undefined>;
        const entity = created[responseKey];
        await this.logPush(entityType, sourceId, entity?.Id ?? "", entity?.SyncToken ?? "0");
        out.pushed.push(ref);
        out.results.push({
          entityType, sourceId, ref, status: "ok", qboId: entity?.Id,
          warning: closeMsg ? `${ref} is ${closeMsg}` : undefined,
        });
      } catch (err) {
        const error = String((err as Error).message).slice(0, 300);
        out.failed.push({ ref, error });
        out.results.push({ entityType, sourceId, ref, status: "failed", error });
      }
    }

    await this.recordResults(out.results, opts);
    if (opts.dryRun) return dry;
    await this.noteSync(
      `push-${entityType}: ${out.pushed.length} pushed, ${out.skipped.length} skipped, ${out.failed.length} failed`,
    );
    return out;
  }

  private async noteSync(note: string) {
    await this.connFilter(
      this.deps.supabase.from("qb_connection")
        .update({ last_sync_at: new Date().toISOString(), last_sync_note: note }),
    );
  }

  // ── Journal entries ────────────────────────────────────────────────────

  async pushJournalEntries(
    entries: CanonicalJournalEntry[],
    accountMap: ChartAccount[],
    opts: PushOptions = {},
  ): Promise<PushSummary | DryRunReport> {
    const session = await this.connect();
    const qbByCode = new Map(accountMap.map((a) => [a.code, a]));
    // Resolved on first AR/AP line; QBO refuses journal lines on those
    // accounts without a customer/vendor Entity.
    let arCustomerId: string | null = null;
    let apVendorId: string | null = null;
    return this.runPush(
      "journalentry", "/journalentry", "JournalEntry",
      entries,
      { ref: (e) => e.entryNo, date: (e) => e.date, sourceId: (e) => e.sourceId },
      async (e) => {
        const lines = [];
        const dryLines: DryRunLine[] = [];
        let balance = 0;
        for (const l of e.lines) {
          const acct = qbByCode.get(l.accountCode);
          const r = await this.resolveAccount(session, acct?.qbName, acct?.qbType, opts);
          dryLines.push({
            accountCode: l.accountCode, qbName: acct?.qbName, qboId: r.id,
            debit: Number(l.debit) || undefined, credit: Number(l.credit) || undefined,
            memo: l.memo ?? e.memo ?? "",
          });
          if (!r.id) return { lines: dryLines, error: `account "${l.accountCode}": ${r.error}` };
          balance += Number(l.debit ?? 0) - Number(l.credit ?? 0);
          const detail: Record<string, unknown> = {
            PostingType: Number(l.debit) > 0 ? "Debit" : "Credit",
            AccountRef: { value: r.id },
          };
          // AR/AP journal lines need a counterparty Entity in QBO; GL-level
          // entries have none, so the configured clearing names stand in.
          if (acct?.qbType === "Accounts Receivable") {
            if (!this.deps.clearingCustomerName) {
              return { lines: dryLines, error: "entry posts to AR and no clearing customer is configured" };
            }
            arCustomerId ??= (await this.resolveCustomer(session, this.deps.clearingCustomerName, { ...opts, autoCreate: true })).id ?? null;
            if (!arCustomerId) return { lines: dryLines, error: `could not resolve clearing customer "${this.deps.clearingCustomerName}"` };
            detail.Entity = { Type: "Customer", EntityRef: { value: arCustomerId } };
          } else if (acct?.qbType === "Accounts Payable") {
            if (!this.deps.clearingVendorName) {
              return { lines: dryLines, error: "entry posts to AP and no clearing vendor is configured" };
            }
            apVendorId ??= (await this.resolveVendor(session, this.deps.clearingVendorName, { ...opts, autoCreate: true })).id ?? null;
            if (!apVendorId) return { lines: dryLines, error: `could not resolve clearing vendor "${this.deps.clearingVendorName}"` };
            detail.Entity = { Type: "Vendor", EntityRef: { value: apVendorId } };
          }
          lines.push({
            DetailType: "JournalEntryLineDetail",
            Amount: Number(l.debit) > 0 ? Number(l.debit) : Number(l.credit),
            Description: l.memo ?? e.memo ?? "",
            JournalEntryLineDetail: detail,
          });
        }
        if (Math.abs(balance) > 0.005) {
          return { lines: dryLines, error: `out of balance by ${balance.toFixed(2)}` };
        }
        return {
          lines: dryLines,
          body: {
            TxnDate: e.date,
            DocNumber: String(e.entryNo),
            PrivateNote: e.memo ?? "",
            Line: lines,
          },
        };
      },
      opts,
      session,
    );
  }

  // ── Payments (+ application, + undeposited mode) ───────────────────────

  async pushPayments(
    payments: CanonicalPayment[],
    opts: PushOptions & { depositMode?: "direct" | "undeposited" } = {},
  ): Promise<PushSummary | DryRunReport> {
    const session = await this.connect();
    const qboIds = await this.accountIds(session);
    return this.runPush(
      "payment", "/payment", "Payment",
      payments,
      { ref: (p) => p.paymentNo, date: (p) => p.date, sourceId: (p) => p.sourceId },
      async (p) => {
        const cust = await this.resolveCustomer(session, p.customerName, opts);
        if (!cust.id) return { lines: [], error: cust.error };
        const body: Record<string, unknown> = {
          TotalAmt: Number(p.amount),
          TxnDate: p.date,
          PaymentRefNum: String(p.paymentNo),
          CustomerRef: { value: cust.id },
          PrivateNote: [p.method, p.reference, p.appliedToInvoiceNo ? `applies to ${p.appliedToInvoiceNo}` : null]
            .filter(Boolean).join(" · "),
        };
        const dryLines: DryRunLine[] = [{ amount: Number(p.amount), memo: `customer ${p.customerName}` }];
        // 'undeposited' leaves off DepositToAccountRef → QBO files the
        // payment under Undeposited Funds for the grouped deposit (#1225).
        if ((opts.depositMode ?? "direct") === "direct" && p.depositToQbAccount) {
          const acctId = qboIds.get(p.depositToQbAccount);
          if (acctId) body.DepositToAccountRef = { value: acctId };
        }
        // Payment application (#1224): link to the invoice by DocNumber.
        if (p.appliedToInvoiceNo) {
          const invId = await this.invoiceId(session, cust.id, p.appliedToInvoiceNo);
          if (invId) {
            body.Line = [{ Amount: Number(p.amount), LinkedTxn: [{ TxnId: invId, TxnType: "Invoice" }] }];
            dryLines[0].memo += ` → invoice ${p.appliedToInvoiceNo}`;
          }
        }
        return { body, lines: dryLines };
      },
      opts,
      session,
    );
  }

  /**
   * Maintenance: delete QBO journal entries whose DocNumber appears more
   * than once, keeping the earliest (lowest QBO Id). Exists because a
   * dedupe failure can only be repaired QBO-side; returns the mapping so
   * callers can backfill qb_push_log for the kept copies.
   */
  async dedupeJournalEntries(session: QboSession): Promise<{
    kept: Array<{ docNumber: string; qboId: string }>;
    deleted: Array<{ docNumber: string; qboId: string }>;
  }> {
    const res = await this.qbo(
      session,
      `/query?query=${encodeURIComponent("select Id, DocNumber from journalentry maxresults 1000")}`,
    ) as { QueryResponse?: { JournalEntry?: Array<{ Id: string; DocNumber?: string }> } };
    const byDoc = new Map<string, string[]>();
    for (const je of res.QueryResponse?.JournalEntry ?? []) {
      if (!je.DocNumber) continue;
      byDoc.set(je.DocNumber, [...(byDoc.get(je.DocNumber) ?? []), je.Id]);
    }
    const kept: Array<{ docNumber: string; qboId: string }> = [];
    const deleted: Array<{ docNumber: string; qboId: string }> = [];
    for (const [docNumber, ids] of byDoc) {
      if (ids.length < 2) continue;
      const sorted = ids.slice().sort((a, b) => Number(a) - Number(b));
      kept.push({ docNumber, qboId: sorted[0] });
      for (const id of sorted.slice(1)) {
        const full = await this.qbo(session, `/journalentry/${id}?minorversion=73`) as { JournalEntry?: { Id: string; SyncToken: string } };
        if (!full.JournalEntry) continue;
        await this.qbo(session, `/journalentry?operation=delete&minorversion=73`, {
          method: "POST",
          body: JSON.stringify({ Id: full.JournalEntry.Id, SyncToken: full.JournalEntry.SyncToken }),
        });
        deleted.push({ docNumber, qboId: id });
      }
    }
    return { kept, deleted };
  }

  /** Look up a QBO Invoice by DocNumber for a customer; null = not found. */
  private async invoiceId(session: QboSession, customerId: string, docNumber: string): Promise<string | null> {
    const res = await this.qbo(
      session,
      `/query?query=${encodeURIComponent(`select Id from invoice where DocNumber = '${docNumber.replace(/'/g, "\\'")}' and CustomerRef = '${customerId}'`)}`,
    ) as { QueryResponse?: { Invoice?: Array<{ Id: string }> } };
    return res.QueryResponse?.Invoice?.[0]?.Id ?? null;
  }

  /**
   * #1225: group a run's pushed payments by (date, bank account) and create
   * one QBO Deposit per group, moving them out of Undeposited Funds.
   * `pushed` must be the run's ok payment results paired with their
   * canonical payments (the caller has both).
   */
  async createDeposits(
    payments: CanonicalPayment[],
    qboIdBySourceId: Map<string, string>,
    opts: PushOptions = {},
  ): Promise<PushSummary | DryRunReport> {
    const session = await this.connect();
    const qboIds = await this.accountIds(session);

    const groups = new Map<string, { date: string; account: string; payments: CanonicalPayment[] }>();
    for (const p of payments) {
      if (!qboIdBySourceId.has(p.sourceId)) continue; // only what actually pushed
      const account = p.depositToQbAccount ?? "";
      const key = `${p.date}|${account}`;
      const g = groups.get(key) ?? { date: p.date, account, payments: [] };
      g.payments.push(p);
      groups.set(key, g);
    }

    const deposits = [...groups.values()].map((g) => ({
      ...g,
      sourceId: `deposit:${g.date}:${g.account || "none"}`,
      ref: `DEP-${g.date}-${g.account || "none"}`,
    }));

    return this.runPush(
      "deposit", "/deposit", "Deposit",
      deposits,
      { ref: (d) => d.ref, date: (d) => d.date, sourceId: (d) => d.sourceId },
      async (d) => {
        if (!d.account) {
          return { lines: [], error: "payments have no bank account to deposit into" };
        }
        const acctId = qboIds.get(d.account);
        if (!acctId) return { lines: [], error: `no QBO account "${d.account}" for the deposit` };
        const lines = d.payments.map((p) => ({
          Amount: Number(p.amount),
          LinkedTxn: [{ TxnId: qboIdBySourceId.get(p.sourceId), TxnType: "Payment" }],
        }));
        return {
          lines: d.payments.map((p) => ({ amount: Number(p.amount), memo: p.paymentNo })),
          body: {
            TxnDate: d.date,
            DepositToAccountRef: { value: acctId },
            PrivateNote: `connector grouped deposit (${d.payments.length} payments)`,
            Line: lines,
          },
        };
      },
      opts,
      session,
    );
  }

  // ── Native entities (#1224) ────────────────────────────────────────────

  async pushInvoices(
    invoices: CanonicalInvoice[],
    opts: PushOptions = {},
  ): Promise<PushSummary | DryRunReport> {
    const session = await this.connect();
    return this.runPush(
      "invoice", "/invoice", "Invoice",
      invoices,
      { ref: (i) => i.invoiceNo, date: (i) => i.date, sourceId: (i) => i.sourceId },
      async (inv) => {
        const cust = await this.resolveCustomer(session, inv.customerName, opts);
        if (!cust.id) return { lines: [], error: cust.error };
        const lines = [];
        const dryLines: DryRunLine[] = [];
        const allLines = [
          ...inv.lines,
          ...(inv.freight && Number(inv.freight.amount) > 0
            ? [{ itemName: GENERIC_ITEM, description: inv.freight.description ?? "Freight", qty: 1, rate: Number(inv.freight.amount), amount: Number(inv.freight.amount) }]
            : []),
        ];
        for (const l of allLines) {
          const item = await this.resolveItem(session, l.itemName, opts);
          dryLines.push({ qbName: l.itemName, qboId: item.id, amount: Number(l.amount), memo: l.description ?? null });
          if (!item.id) return { lines: dryLines, error: item.error };
          lines.push({
            DetailType: "SalesItemLineDetail",
            Amount: Number(l.amount),
            Description: l.description ?? "",
            SalesItemLineDetail: {
              ItemRef: { value: item.id },
              Qty: Number(l.qty),
              UnitPrice: Number(l.rate),
            },
          });
        }
        return {
          lines: dryLines,
          body: {
            TxnDate: inv.date,
            ...(inv.dueDate ? { DueDate: inv.dueDate } : {}),
            DocNumber: String(inv.invoiceNo),
            CustomerRef: { value: cust.id },
            PrivateNote: inv.memo ?? "",
            Line: lines,
          },
        };
      },
      opts,
      session,
    );
  }

  async pushBills(
    bills: CanonicalBill[],
    accountMap: ChartAccount[],
    opts: PushOptions = {},
  ): Promise<PushSummary | DryRunReport> {
    const session = await this.connect();
    const qbByCode = new Map(accountMap.map((a) => [a.code, a]));
    return this.runPush(
      "bill", "/bill", "Bill",
      bills,
      { ref: (b) => b.billNo, date: (b) => b.date, sourceId: (b) => b.sourceId },
      async (b) => {
        const vendor = await this.resolveVendor(session, b.vendorName, opts);
        if (!vendor.id) return { lines: [], error: vendor.error };
        const lines = [];
        const dryLines: DryRunLine[] = [];
        for (const l of b.lines) {
          const acct = qbByCode.get(l.accountCode);
          const r = await this.resolveAccount(session, acct?.qbName, acct?.qbType, opts);
          dryLines.push({ accountCode: l.accountCode, qbName: acct?.qbName, qboId: r.id, amount: Number(l.amount), memo: l.description ?? null });
          if (!r.id) return { lines: dryLines, error: `account "${l.accountCode}": ${r.error}` };
          lines.push({
            DetailType: "AccountBasedExpenseLineDetail",
            Amount: Number(l.amount),
            Description: l.description ?? "",
            AccountBasedExpenseLineDetail: { AccountRef: { value: r.id } },
          });
        }
        return {
          lines: dryLines,
          body: {
            TxnDate: b.date,
            ...(b.dueDate ? { DueDate: b.dueDate } : {}),
            DocNumber: String(b.billNo),
            VendorRef: { value: vendor.id },
            PrivateNote: b.memo ?? "",
            Line: lines,
          },
        };
      },
      opts,
      session,
    );
  }

  async pushCreditMemos(
    memos: CanonicalCreditMemo[],
    opts: PushOptions = {},
  ): Promise<PushSummary | DryRunReport> {
    const session = await this.connect();
    return this.runPush(
      "creditmemo", "/creditmemo", "CreditMemo",
      memos,
      { ref: (c) => c.controlNo, date: (c) => c.date, sourceId: (c) => c.sourceId },
      async (cm) => {
        const cust = await this.resolveCustomer(session, cm.customerName, opts);
        if (!cust.id) return { lines: [], error: cust.error };
        const lines = [];
        const dryLines: DryRunLine[] = [];
        for (const l of cm.lines) {
          const item = await this.resolveItem(session, l.itemName, opts);
          dryLines.push({ qbName: l.itemName, qboId: item.id, amount: Number(l.amount), memo: l.description ?? null });
          if (!item.id) return { lines: dryLines, error: item.error };
          lines.push({
            DetailType: "SalesItemLineDetail",
            Amount: Number(l.amount),
            Description: l.description ?? "",
            SalesItemLineDetail: {
              ItemRef: { value: item.id },
              Qty: Number(l.qty),
              UnitPrice: Number(l.rate),
            },
          });
        }
        return {
          lines: dryLines,
          body: {
            TxnDate: cm.date,
            DocNumber: String(cm.controlNo),
            CustomerRef: { value: cust.id },
            PrivateNote: cm.memo ?? "",
            Line: lines,
          },
        };
      },
      opts,
      session,
    );
  }

  // ── Reports ────────────────────────────────────────────────────────────

  /** QBO TrialBalance report, condensed to account → debit/credit. */
  async trialBalance(
    session: QboSession,
    from?: string,
    to?: string,
  ): Promise<Array<{ account: string; debit: number; credit: number }>> {
    const qs = from && to ? `?start_date=${from}&end_date=${to}` : "";
    const rpt = await this.qbo(session, `/reports/TrialBalance${qs}`);
    const out: Array<{ account: string; debit: number; credit: number }> = [];
    const walk = (rows: Array<{ type?: string; ColData?: Array<{ value?: string }>; Rows?: { Row?: unknown[] } }>) => {
      for (const r of rows ?? []) {
        if (r.type === "Data" && r.ColData?.length === 3) {
          out.push({
            account: r.ColData[0]?.value ?? "",
            debit: Number(r.ColData[1]?.value || 0),
            credit: Number(r.ColData[2]?.value || 0),
          });
        }
        const nested = (r.Rows as { Row?: Array<typeof r> } | undefined)?.Row;
        if (nested) walk(nested);
      }
    };
    walk((rpt as { Rows?: { Row?: never[] } }).Rows?.Row ?? []);
    return out;
  }
}
