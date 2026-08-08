# Legacy QuickFlora POS → QBO connector mapping (#1205, design start)

Status: **design draft — nothing here is implemented**. Column names marked
`TODO(verify)` were not confirmed against the live database. Do not build
from this document until the open questions are answered.

## Source system

| Fact | Value |
|---|---|
| System | Legacy QuickFlora POS (desktop/web, pre-Supabase) |
| Store | SQL Server, host `DB1AWS` |
| Ledger table | `LedgerMain` (general ledger header+lines, single-table design) |
| Access path | READ-ONLY, via the Core API (`NewApplication` schema) — never direct SQL |
| Direction | POS → QBO only (one-way sync) |

The Core API is the only sanctioned read path: the POS database is shared
with production terminals, so the connector reads through the API's
`NewApplication` schema views/procs and holds no SQL Server credentials of
its own.

## Mapping approach

LedgerMain rows → `CanonicalJournalEntry` (core/contract.ts). One QBO
JournalEntry per source posting; `sourceId` = the LedgerMain primary key
(`TODO(verify)` column name), which makes the shared `qb_push_log` unique
key the no-double-post control, same as every other product.

### Proposed field mapping (all source columns unverified)

| Canonical field | LedgerMain source | Notes |
|---|---|---|
| `entryNo` | `TODO(verify)` — likely a journal/entry number column | must be stable and unique per posting |
| `date` | `TODO(verify)` — posting/effective date column | convert to ISO date; confirm timezone (server local vs UTC) |
| `memo` | `TODO(verify)` — description/comment column | |
| `sourceType` | constant `"quickflora-pos"` (or a LedgerMain type column if one exists) | |
| `sourceId` | `TODO(verify)` — LedgerMain PK | |
| `lines[].accountCode` | `TODO(verify)` — account number column | needs a POS-account → QBO-account map (see below) |
| `lines[].debit` / `lines[].credit` | `TODO(verify)` — amount + a debit/credit flag, or signed amounts split by sign | confirm which representation LedgerMain uses |
| `lines[].memo` | `TODO(verify)` — line description if present | |

### Account map

`qb_account_map`-equivalent for the POS chart of accounts. Open question:
does the POS chart live in a table the Core API exposes (`TODO(verify)`), or
do we ship a static mapping table with the connector? Default assumption:
static table seeded at onboarding, edited per florist during setup.

### Payments

POS tenders (cash/check/card settlements) → `CanonicalPayment`. Whether
customer-level payments exist in LedgerMain or in a separate receipts table
is `TODO(verify)`. If card settlements arrive as daily batch totals rather
than per-invoice receipts, payments should post to a clearing customer
(`clearingCustomerName` in ConnectorConfig) with the batch reference in
`reference`.

## Needs Ved's approval

1. Reading LedgerMain through the Core API at all (production DB load).
2. The account mapping table contents (POS account → QBO account) — he owns
   the legacy chart's meaning.
3. Whether POS data posts to QBO as journal entries only, or invoices +
   payments (affects whether QBO A/R stays meaningful per customer).
4. Backfill window: how far back the first sync should read (window_days on
   the schedule) — large backfills need a staged plan.

## Open questions

1. Exact LedgerMain column names and types (all `TODO(verify)` above).
2. Is there a line-level table (LedgerDetail?) or is LedgerMain
   header-and-lines in one row?
3. Are postings immutable, or can a posted entry be edited/voided — and if
   so, how do we detect and reverse an already-pushed entry? (The current
   contract is append-only; edits after push are out of scope for v1.)
4. Which Core API endpoint/shape returns ledger rows, and is it paged?
5. Multi-store: is there one LedgerMain per store/company, and does each
   map to a separate connector `tenantId`?
6. Currency: any non-USD postings?
