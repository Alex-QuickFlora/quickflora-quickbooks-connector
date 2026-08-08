/**
 * QBO API client — token lifecycle, fetch wrapper, entity pushes, reports.
 *
 * Ported from FloraChain's proven supabase/functions/qbo-api/index.ts and
 * generalized: the hardcoded demo-tenant uuid is gone; every call is scoped
 * by (product, tenantId). Contains ZERO product-specific SQL — the only
 * tables touched are the connector's own shared ones (qb_connection,
 * qb_push_log).
 *
 * Access tokens are minted per call from the stored refresh token. Refresh
 * tokens ROLL: Intuit returns a new one on (nearly) every refresh, and the
 * old one dies — so the new token is persisted immediately, keyed by
 * (product, tenant_id).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  CanonicalJournalEntry,
  CanonicalPayment,
  ChartAccount,
  QboConnectionRow,
  PushSummary,
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

export class QboClient {
  constructor(
    private deps: {
      supabase: SupabaseClient;
      product: string;
      tenantId: string;
      clientId: string;
      clientSecret: string;
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

  /** QBO account Name -> Id, fetched once per run and cached. */
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
   * dies on "no QBO account X" when we could have just made it.
   */
  async ensureAccounts(session: QboSession, map: ChartAccount[]): Promise<{ created: string[] }> {
    const existing = await this.accountIds(session);
    const created: string[] = [];
    for (const a of map) {
      if (existing.has(a.qbName)) continue;
      const res = await this.qbo(session, `/account?minorversion=73`, {
        method: "POST",
        body: JSON.stringify({ Name: a.qbName, AccountType: a.qbType }),
      }) as { Account?: { Id?: string } };
      if (res.Account?.Id) {
        existing.set(a.qbName, res.Account.Id);
        created.push(a.qbName);
      }
    }
    return { created };
  }

  /** The no-double-post control: shared qb_push_log, unique per source row. */
  private async alreadyPushed(entityType: string, sourceId: string): Promise<boolean> {
    const { data } = await this.connFilter(
      this.deps.supabase.from("qb_push_log")
        .select("id").eq("entity_type", entityType).eq("source_id", sourceId),
    );
    return (data?.length ?? 0) > 0;
  }

  private async logPush(entityType: string, sourceId: string, qboId: string, syncToken: string) {
    await this.deps.supabase.from("qb_push_log").insert({
      product: this.deps.product,
      tenant_id: this.deps.tenantId,
      entity_type: entityType,
      source_id: sourceId,
      qbo_id: qboId,
      sync_token: syncToken,
    });
  }

  private async noteSync(note: string) {
    await this.connFilter(
      this.deps.supabase.from("qb_connection")
        .update({ last_sync_at: new Date().toISOString(), last_sync_note: note }),
    );
  }

  /** Push canonical journal entries as QBO JournalEntry objects. */
  async pushJournalEntries(
    session: QboSession,
    entries: CanonicalJournalEntry[],
    accountMap: ChartAccount[],
  ): Promise<PushSummary> {
    const qboIds = await this.accountIds(session);
    const qbNameByCode = new Map(accountMap.map((a) => [a.code, a.qbName]));
    const out: PushSummary = { pushed: [], skipped: [], failed: [] };

    for (const e of entries) {
      if (await this.alreadyPushed("journalentry", e.sourceId)) {
        out.skipped.push(e.entryNo);
        continue;
      }
      const lines = [];
      let postable = true;
      for (const l of e.lines) {
        const qbName = qbNameByCode.get(l.accountCode);
        const qboId = qbName ? qboIds.get(qbName) : undefined;
        if (!qboId) {
          out.failed.push({
            ref: e.entryNo,
            error: `no QBO account for "${l.accountCode}" (mapped to "${qbName ?? "—"}") — fix the account map or run ensure-accounts`,
          });
          postable = false;
          break;
        }
        lines.push({
          DetailType: "JournalEntryLineDetail",
          Amount: Number(l.debit) > 0 ? Number(l.debit) : Number(l.credit),
          Description: l.memo ?? e.memo ?? "",
          JournalEntryLineDetail: {
            PostingType: Number(l.debit) > 0 ? "Debit" : "Credit",
            AccountRef: { value: qboId },
          },
        });
      }
      if (!postable) continue;

      try {
        const created = await this.qbo(session, `/journalentry?minorversion=73`, {
          method: "POST",
          body: JSON.stringify({
            TxnDate: e.date,
            DocNumber: String(e.entryNo),
            PrivateNote: e.memo ?? "",
            Line: lines,
          }),
        }) as { JournalEntry?: { Id?: string; SyncToken?: string } };
        const je = created.JournalEntry;
        await this.logPush("journalentry", e.sourceId, je?.Id ?? "", je?.SyncToken ?? "0");
        out.pushed.push(e.entryNo);
      } catch (err) {
        out.failed.push({ ref: e.entryNo, error: String((err as Error).message).slice(0, 300) });
      }
    }
    await this.noteSync(
      `push-journal: ${out.pushed.length} pushed, ${out.skipped.length} skipped, ${out.failed.length} failed`,
    );
    return out;
  }

  /**
   * QBO Customer DisplayName -> Id, resolved per push run. When the customer
   * is missing, the configured clearing customer is used (and created on
   * first use); without one the payment fails loudly — silently posting to
   * the wrong customer is worse than not posting.
   */
  private async customerId(
    session: QboSession,
    name: string,
    clearingCustomerName?: string,
  ): Promise<string> {
    const find = async (display: string) => {
      const res = await this.qbo(
        session,
        `/query?query=${encodeURIComponent(`select Id, DisplayName from customer where DisplayName = '${display.replace(/'/g, "\\'")}'`)}`,
      ) as { QueryResponse?: { Customer?: Array<{ Id: string }> } };
      return res.QueryResponse?.Customer?.[0]?.Id ?? null;
    };
    const direct = await find(name);
    if (direct) return direct;
    if (!clearingCustomerName) {
      throw new Error(`QBO customer "${name}" not found and no clearing customer is configured`);
    }
    const clearing = await find(clearingCustomerName);
    if (clearing) return clearing;
    const created = await this.qbo(session, `/customer?minorversion=73`, {
      method: "POST",
      body: JSON.stringify({ DisplayName: clearingCustomerName }),
    }) as { Customer?: { Id?: string } };
    if (!created.Customer?.Id) throw new Error(`could not create clearing customer "${clearingCustomerName}"`);
    return created.Customer.Id;
  }

  /** Try to link a payment to a QBO Invoice by DocNumber; null = unapplied. */
  private async invoiceId(session: QboSession, customerId: string, docNumber: string): Promise<string | null> {
    const res = await this.qbo(
      session,
      `/query?query=${encodeURIComponent(`select Id from invoice where DocNumber = '${docNumber.replace(/'/g, "\\'")}' and CustomerRef = '${customerId}'`)}`,
    ) as { QueryResponse?: { Invoice?: Array<{ Id: string }> } };
    return res.QueryResponse?.Invoice?.[0]?.Id ?? null;
  }

  /** Push canonical payments as QBO Payment objects. */
  async pushPayments(
    session: QboSession,
    payments: CanonicalPayment[],
    opts: { clearingCustomerName?: string } = {},
  ): Promise<PushSummary> {
    const qboIds = await this.accountIds(session);
    const out: PushSummary = { pushed: [], skipped: [], failed: [] };

    for (const p of payments) {
      if (await this.alreadyPushed("payment", p.sourceId)) {
        out.skipped.push(p.paymentNo);
        continue;
      }
      try {
        const custId = await this.customerId(session, p.customerName, opts.clearingCustomerName);
        const body: Record<string, unknown> = {
          TotalAmt: Number(p.amount),
          TxnDate: p.date,
          PaymentRefNum: String(p.paymentNo),
          CustomerRef: { value: custId },
          PrivateNote: [p.method, p.reference, p.appliedToRef ? `applies to ${p.appliedToRef}` : null]
            .filter(Boolean).join(" · "),
        };
        if (p.depositToQbAccount && qboIds.has(p.depositToQbAccount)) {
          body.DepositToAccountRef = { value: qboIds.get(p.depositToQbAccount) };
        }
        if (p.appliedToRef) {
          const invId = await this.invoiceId(session, custId, p.appliedToRef);
          if (invId) {
            body.Line = [{ Amount: Number(p.amount), LinkedTxn: [{ TxnId: invId, TxnType: "Invoice" }] }];
          }
        }
        const created = await this.qbo(session, `/payment?minorversion=73`, {
          method: "POST",
          body: JSON.stringify(body),
        }) as { Payment?: { Id?: string; SyncToken?: string } };
        await this.logPush("payment", p.sourceId, created.Payment?.Id ?? "", created.Payment?.SyncToken ?? "0");
        out.pushed.push(p.paymentNo);
      } catch (err) {
        out.failed.push({ ref: p.paymentNo, error: String((err as Error).message).slice(0, 300) });
      }
    }
    await this.noteSync(
      `push-payments: ${out.pushed.length} pushed, ${out.skipped.length} skipped, ${out.failed.length} failed`,
    );
    return out;
  }

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
