/**
 * FloraChain adapter — the REFERENCE adapter (#1204).
 *
 * Everything below is the product-specific SQL that used to live inside the
 * qbo-api edge function, extracted behind the ProductAdapter interface:
 *   account map     qb_account_map → gl_account (code, name, type)
 *   journal entries journal_entry + journal_entry_line + gl_account
 *   payments        payment + payment_method + customer (+ sales_order for
 *                   invoice application, #1224)
 *   invoices        invoice + sales_order(_line) + product (#1224)
 *   bills           vendor_bill + vendor_bill_line + vendor/farm (#1224)
 *   credit memos    credit_claim (customer-charged only) (#1224)
 *
 * New adapters: copy this file, change the queries, keep the shapes.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  AdapterFactory,
  CanonicalBill,
  CanonicalCreditMemo,
  CanonicalInvoice,
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
        .select("id, payment_no, payment_date, amount, reference, sales_order_id, customer:customer_id(name), payment_method:payment_method_id(name, gl_account_id), sales_order:sales_order_id(invoice_no)")
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
        // #1224: apply the payment to its order's invoice when the invoice
        // number exists in QBO (DocNumber); otherwise it posts unapplied.
        appliedToInvoiceNo: p.sales_order?.invoice_no ?? null,
        reference: p.reference ?? null,
        sourceId: p.id,
      }));
    },

    async getInvoices(from: string, to: string): Promise<CanonicalInvoice[]> {
      const { data: invoices, error } = await db
        .from("invoice")
        .select("id, invoice_no, invoice_date, due_date, freight, memo:notes, subtotal, customer:customer_id(name)")
        .eq("tenant_id", tenant)
        .is("deleted_at", null)
        .gte("invoice_date", from)
        .lte("invoice_date", to)
        .order("invoice_no");
      if (error) throw error;
      if (!invoices?.length) return [];

      // Invoice lines are the lines of the orders on the invoice.
      const { data: orders, error: oErr } = await db
        .from("sales_order")
        .select("id, invoice_no")
        .eq("tenant_id", tenant)
        .in("invoice_no", invoices.map((i: any) => i.invoice_no));
      if (oErr) throw oErr;
      const orderIds = (orders ?? []).map((o: any) => o.id);
      const orderInvNo = new Map((orders ?? []).map((o: any) => [o.id, o.invoice_no]));

      const { data: lines, error: lErr } = orderIds.length
        ? await db
          .from("sales_order_line")
          .select("sales_order_id, qty_units, unit_price, line_total, product:product_id(sku, description)")
          .in("sales_order_id", orderIds)
        : { data: [], error: null };
      if (lErr) throw lErr;

      const linesByInvNo = new Map<string, any[]>();
      for (const l of lines ?? []) {
        const invNo = orderInvNo.get(l.sales_order_id);
        if (!invNo) continue;
        const arr = linesByInvNo.get(invNo) ?? [];
        arr.push(l);
        linesByInvNo.set(invNo, arr);
      }

      return invoices.map((i: any) => ({
        invoiceNo: String(i.invoice_no),
        date: i.invoice_date,
        dueDate: i.due_date ?? null,
        customerName: i.customer?.name ?? "Unknown customer",
        arAccountCode: null, // QBO posts to the company's default A/R
        lines: (linesByInvNo.get(i.invoice_no) ?? []).map((l: any) => ({
          itemName: l.product?.sku ?? "Services",
          description: l.product?.description ?? null,
          qty: Number(l.qty_units ?? 0),
          rate: Number(l.unit_price ?? 0),
          amount: Number(l.line_total ?? 0),
        })),
        freight: Number(i.freight ?? 0) > 0
          ? { description: "Freight on invoice", amount: Number(i.freight) }
          : null,
        memo: i.memo ?? null,
        sourceId: i.id,
      }));
    },

    async getBills(from: string, to: string): Promise<CanonicalBill[]> {
      const { data: bills, error } = await db
        .from("vendor_bill")
        .select("id, bill_no, bill_date, due_date, reference, vendor:vendor_id(name), farm:farm_id(name), vendor_bill_line(account_id, description, amount, gl_account:account_id(code))")
        .eq("tenant_id", tenant)
        .gte("bill_date", from)
        .lte("bill_date", to)
        .order("bill_no");
      if (error) throw error;
      return (bills ?? []).map((b: any) => ({
        billNo: String(b.bill_no),
        date: b.bill_date,
        dueDate: b.due_date ?? null,
        // Farm-direct bills name the farm as the QBO vendor.
        vendorName: b.vendor?.name ?? b.farm?.name ?? "Unknown vendor",
        lines: (b.vendor_bill_line ?? []).map((l: any) => ({
          accountCode: l.gl_account?.code ?? "",
          description: l.description ?? null,
          amount: Number(l.amount ?? 0),
        })),
        memo: b.reference ?? null,
        sourceId: b.id,
      }));
    },

    async getCreditMemos(from: string, to: string): Promise<CanonicalCreditMemo[]> {
      const { data, error } = await db
        .from("credit_claim")
        .select("id, control_no, created_at, reason, credit_units, credit_price, credit_amount, freight_credit, customer:customer_id(name), product:product_id(sku, description)")
        .eq("tenant_id", tenant)
        .is("deleted_at", null)
        .gte("created_at", `${from}T00:00:00Z`)
        .lte("created_at", `${to}T23:59:59Z`)
        .order("control_no");
      if (error) throw error;
      return (data ?? [])
        // Claims without a customer (farm-charged) are not customer credit
        // memos — they belong on the grower settlement side.
        .filter((c: any) => c.customer?.name)
        .map((c: any) => {
          const lines = [{
            itemName: c.product?.sku ?? "Services",
            description: c.reason ?? c.product?.description ?? "Credit claim",
            qty: Number(c.credit_units ?? 1) || 1,
            rate: Number(c.credit_price ?? 0),
            amount: Number(c.credit_amount ?? 0),
          }];
          if (Number(c.freight_credit ?? 0) > 0) {
            lines.push({
              itemName: "Services",
              description: "Freight credit",
              qty: 1,
              rate: Number(c.freight_credit),
              amount: Number(c.freight_credit),
            });
          }
          return {
            controlNo: String(c.control_no),
            date: String(c.created_at).slice(0, 10),
            customerName: c.customer.name,
            lines,
            memo: c.reason ?? null,
            sourceId: c.id,
          };
        });
    },
  };
};
