/**
 * eVenta adapter (#1206) — SKELETON. No eVenta schema was available at
 * authoring time, so every query is a documented TODO. It compiles and
 * throws loudly if called, so the scheduler's per-tenant isolation records
 * a clean error instead of pushing garbage.
 *
 * DOCUMENTED ASSUMPTIONS (to confirm against the real schema):
 *  - eVenta sells event registrations/tickets; revenue is recognized per
 *    EVENT, deposits are taken up front and held as deferred revenue
 *    (liability) until the event settles.
 *  - Expected canonical mapping:
 *      deposit received   → DR Cash/Stripe clearing, CR Deferred Revenue
 *      event settlement   → DR Deferred Revenue, CR Event Revenue
 *      refunds            → DR Event Revenue (or Refunds), CR Cash
 *  - Expected source tables (names INVENTED as placeholders):
 *      event, event_order, event_payment, event_settlement
 *  - Chart of accounts: eventa likely has no gl_account table at all — the
 *    account map may be a static config list instead of a SQL join.
 */

import type {
  AdapterFactory,
  CanonicalJournalEntry,
  CanonicalPayment,
  ChartAccount,
} from "../../core/contract.ts";

const NOT_IMPLEMENTED =
  "eVenta adapter is a skeleton — no schema verified yet. See adapters/eventa/adapter.ts header.";

export const createEventaAdapter: AdapterFactory = (_cfg) => ({
  getAccountMap(): Promise<ChartAccount[]> {
    // TODO(schema): static config list, or eventa chart-of-accounts table.
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  },
  getJournalEntries(_from: string, _to: string): Promise<CanonicalJournalEntry[]> {
    // TODO(schema): event settlements → CanonicalJournalEntry (DR Deferred
    // Revenue / CR Event Revenue per the assumptions above).
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  },
  getPayments(_from: string, _to: string): Promise<CanonicalPayment[]> {
    // TODO(schema): event_payment rows → CanonicalPayment; attendee/
    // organizer as the QBO customer is an open question.
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  },
});
