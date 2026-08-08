/**
 * FloraChain adapter — the REFERENCE adapter (#1204).
 *
 * Everything below is the product-specific SQL that used to live inside the
 * qbo-api edge function, extracted behind the ProductAdapter interface:
 *   account map     qb_account_map → gl_account (code, name, type)
 *   journal entries journal_entry + journal_entry_line + gl_account
 *   payments        payment + payment_method + customer
 *
 * New adapters: copy this file, change the queries, keep the shapes.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  AdapterFactory,
  CanonicalJournalEntry,
  CanonicalPayment,
  ChartAccount,
} from "../../core/contract.ts";

/** qb_account_map.qb_type stores QBO's abbreviations; the create-Account API
 *  wants the full AccountType name. */
const QB_TYPE_NAMES: Record<string, string> = {
  BANK: "Bank",
  AR: "Accounts Receivable",
  OCASSET: "Other Current Asset",
  FIXASSET: "Fixed Asset",
  OASSET: "Other Asset",
  AP: "Accounts Payable",
  CCARD: "Credit Card",
  OCLIAB: "Other Current Liability",
  LTLIAB: "Long Term Liability",
  EQ: "Equity",
  INC: "Income",
  OTHINC: "Other Income",
  COGS: "Cost of Goods Sold",
  EXP: "Expense",
  OTHEXP: "Other Expense",
};

export const createFlorachainAdapter: AdapterFactory = (cfg) => {
  const db = createClient(cfg.supabaseUrl, cfg.serviceRoleKey);
  const tenant = cfg.tenantId;

  return {
    async getAccountMap(): Promise<ChartAccount[]> {
      const { data, error } = await db
        .from("qb_account_map")
        .select("qb_account, qb_type, gl_account:gl_account_id(code, name)")
        .eq("tenant_id", tenant);
      if (error) throw error;
      return (data ?? []).map((m: any) => ({
        code: m.gl_account?.code ?? "",
        name: m.gl_account?.name ?? "",
        qbName: m.qb_account,
        qbType: QB_TYPE_NAMES[m.qb_type] ?? m.qb_type ?? "Other Current Asset",
      }));
    },

    async getJournalEntries(from: string, to: string): Promise<CanonicalJournalEntry[]> {
      const { data, error } = await db
        .from("journal_entry")
        .select("id, entry_number, entry_date, memo, journal_entry_line(account_id, debit, credit, memo, gl_account:account_id(code, name))")
        .eq("tenant_id", tenant)
        .gte("entry_date", from)
        .lte("entry_date", to)
        .order("entry_number");
      if (error) throw error;
      return (data ?? []).map((e: any) => ({
        entryNo: String(e.entry_number),
        date: e.entry_date,
        memo: e.memo ?? null,
        sourceType: "journal_entry",
        sourceId: e.id,
        lines: (e.journal_entry_line ?? []).map((l: any) => ({
          accountCode: l.gl_account?.code ?? "",
          debit: Number(l.debit ?? 0),
          credit: Number(l.credit ?? 0),
          memo: l.memo ?? null,
        })),
      }));
    },

    async getPayments(from: string, to: string): Promise<CanonicalPayment[]> {
      const { data, error } = await db
        .from("payment")
        .select("id, payment_no, payment_date, amount, reference, sales_order_id, customer:customer_id(name), payment_method:payment_method_id(name, gl_account_id)")
        .eq("tenant_id", tenant)
        .gte("payment_date", from)
        .lte("payment_date", to)
        .order("payment_no");
      if (error) throw error;

      // Deposit account: the payment method's GL account, run through the
      // QBO map. Unmapped methods fall back to QBO's Undeposited Funds.
      const { data: maps } = await db
        .from("qb_account_map")
        .select("gl_account_id, qb_account")
        .eq("tenant_id", tenant);
      const qbByGlId = new Map((maps ?? []).map((m: any) => [m.gl_account_id, m.qb_account]));

      return (data ?? []).map((p: any) => ({
        paymentNo: String(p.payment_no),
        date: p.payment_date,
        customerName: p.customer?.name ?? "Unknown customer",
        amount: Number(p.amount ?? 0),
        method: p.payment_method?.name ?? null,
        depositToQbAccount: p.payment_method?.gl_account_id
          ? qbByGlId.get(p.payment_method.gl_account_id) ?? null
          : null,
        // FloraChain payments sit on sales orders; the invoice DocNumber in
        // QBO is the sales order's invoice number once invoices are pushed —
        // until then payments post unapplied with the reference noted.
        appliedToRef: null,
        reference: p.reference ?? null,
        sourceId: p.id,
      }));
    },
  };
};
