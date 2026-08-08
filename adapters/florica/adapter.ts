/**
 * Florica adapter (#1206).
 *
 * Florica is the storefront Supabase project (hskzxubhvpifybjrmubt) — home
 * of public.inventory, the live price/stock feed the website reads. It
 * belongs to the FloraChain schema family, so this adapter is a thin variant
 * of the reference adapter.
 *
 * TODO(verify): the accounting tables below (journal_entry, payment,
 * qb_account_map, gl_account) are ASSUMED to exist in the florica project
 * with the FloraChain-family shapes. public.inventory is confirmed live; the
 * ledger tables were not verified at authoring time. If florica keeps its
 * books in the FloraChain project instead, this adapter should simply point
 * at that database via ConnectorConfig.supabaseUrl.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  AdapterFactory,
  CanonicalJournalEntry,
  CanonicalPayment,
  ChartAccount,
} from "../../core/contract.ts";

export const createFloricaAdapter: AdapterFactory = (cfg) => {
  const db = createClient(cfg.supabaseUrl, cfg.serviceRoleKey);
  const tenant = cfg.tenantId;

  return {
    async getAccountMap(): Promise<ChartAccount[]> {
      // TODO(verify): qb_account_map / gl_account existence in florica.
      const { data, error } = await db
        .from("qb_account_map")
        .select("qb_account, qb_type, gl_account:gl_account_id(code, name)")
        .eq("tenant_id", tenant);
      if (error) throw error;
      return (data ?? []).map((m: any) => ({
        code: m.gl_account?.code ?? "",
        name: m.gl_account?.name ?? "",
        qbName: m.qb_account,
        qbType: m.qb_type ?? "Other Current Asset", // TODO(verify): abbreviations → full names as in the florachain adapter
      }));
    },

    async getJournalEntries(from: string, to: string): Promise<CanonicalJournalEntry[]> {
      // TODO(verify): journal_entry / journal_entry_line shapes in florica.
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

    getPayments(_from: string, _to: string): Promise<CanonicalPayment[]> {
      // TODO(verify): storefront orders pay online; where settlement rows
      // live in florica is unconfirmed. Returning none until verified.
      return Promise.resolve([]);
    },
  };
};
