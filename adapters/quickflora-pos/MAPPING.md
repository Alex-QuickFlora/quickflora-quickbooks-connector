# Legacy QuickFlora POS → QBO connector mapping (AB#1205)

Status: **verified design**. Every column, count and total below was measured
against the live database on **2026-08-14** (DB1AWS, `Enterprise`,
`CompanyID = 'BerkeleyFloristSupply33142'`, read-only via SSM as SYSTEM).
Figures are as of that date and will drift; the *shapes* are stable.

Supersedes the 2026-08-08 draft, which was built around a table called
`LedgerMain`. **No such table exists** — `LedgerMain_*` is a stored-procedure
name prefix. That draft's entire field map was wrong and has been replaced.

## Source system

| Fact | Value |
|---|---|
| System | Legacy QuickFlora POS |
| Store | SQL Server 2014, host `DB1AWS` (i-00f757c5d0baf6739, 172.30.0.138) |
| Database | `Enterprise` — one DB for all companies, keyed by `CompanyID` |
| First tenant | Berkeley Florist Supply — `BerkeleyFloristSupply33142` |
| Access path | READ-ONLY, via the Core API (`NewApplication` schema) — never direct SQL |
| Direction | POS → QBO only (one-way) |
| Sync state | Supabase only (`qb_push_log`). **Nothing is written to `Enterprise`.** |

The Core API is the only sanctioned read path: the POS database is shared with
production terminals, so the connector reads through the API and holds no SQL
Server credentials of its own. Because all sync state lives in Supabase, this
integration needs **no schema change on DB1AWS** and therefore no Ved-applied
migration — only his sign-off on the read load and the account map.

## Chosen shape: invoices + payments, not journal entries

Decided by Alex, 2026-08-14. The GL route was rejected because it cannot tell
QuickBooks *which customer owes what*, which is the actual Berkeley problem
(orders showing OPEN/unpaid in QBO, reconciled by hand against a CSV).

Berkeley's ledger is live and healthy, so the GL route stays available as a
fallback: 14,906 `LedgerTransactions` headers and 60,270 detail lines,
2026-03-06 → 2026-08-26, over a 142-account chart. Two notes if it is ever
used: the ledger is out of balance by **$434.13** across the period (debits
$2,240,727.62 vs credits $2,240,293.49, a few dollars a month — QBO journal
entries must balance exactly, so this must be resolved first); and Berkeley
has **zero both-sided rows**, so the `LedgerMain_PostCOA` credit-wins bug that
produced Tipton's −$40.4M does not affect it. Even so, any GL adapter must read
raw detail and net debit−credit itself, never `LedgerChartOfAccounts.GLAccountBalance`.

## Measured shape of the data (2026-08-14)

| Fact | Value |
|---|---|
| Orders, all | 9,240 (2026-03-06 → 2026-08-13) |
| Invoiced | 8,311 — **$1,374,049.44** |
| Not invoiced | 929 (out of scope; they have no invoice number yet) |
| Order detail lines | 33,118 (~4 per order) |
| Distinct items | 2,432, zero blank `ItemID` |
| Distinct customers on invoiced orders | 3,029 (of 34,864 customer records) |
| Division / Department | `DEFAULT` / `DEFAULT` only → one connector tenant |
| Currency | `NULL` on every row → single currency, treat as USD |
| Terms | `Net Due` on all 8,311 |
| Negative-total orders | **0** → no credit memos in scope for v1 |

Invoiced orders by `InvoiceDate` — the CPA's reporting basis, not `OrderDate`:

| Month | Orders | Total |
|---|---:|---:|
| 2026-03 | 1,115 | $165,512.70 |
| 2026-04 | 2,054 | $407,371.88 |
| 2026-05 | 2,310 | $395,636.30 |
| 2026-06 | 1,272 | $192,364.21 |
| 2026-07 | 1,143 | $154,375.62 |
| 2026-08 (to the 14th) | 417 | $58,788.73 |

By `OrderHeader.PaymentMethodID` (invoiced only):

| Method | Orders | Total | QBO treatment |
|---|---:|---:|---|
| Offline POS Payment | 5,791 | $684,079.21 | Sales Receipt |
| House Account | 1,808 | $642,551.64 | Invoice (true A/R) |
| Cash | 684 | $43,974.19 | Sales Receipt |
| Credit Card | 23 | $2,795.00 | **open decision** |
| Check | 5 | $649.40 | Sales Receipt |

Transaction types: `Order`/`Order` 8,540, `Order`/`POS` 646, `Wire_Out` 50,
`Invoice` 4. The 50 `Wire_Out` orders need their own rule (see open questions).

## Source tables

`OrderHeader` (Tables2) — one row per order; the invoice header.
`OrderDetail` (Tables2) — one row per line, keyed `OrderLineNumber`.
`OrderHeaderPaymentMethodProcessingDetails` — payment captured at the moment of
sale. 8,739 rows / 8,739 distinct orders (1:1, no fan-out); 8,311 of them sit on
invoiced orders — full coverage.
`CustomerInformation` — joined on `(CompanyID, CustomerID)`; unique, no fan-out.

**Use `OrderHeaderPaymentMethodProcessingDetails.PaymentAmount`, not
`OrderHeader.AmountPaid`.** `AmountPaid` is only written at invoicing, so a
same-day sync reads it as zero and calls yesterday's counter sales unpaid.
`PaymentAmount` is available immediately and equals the eventual `AmountPaid`
exactly. A payment row alone does **not** mean money was collected — it also
exists for House Account (net-30, billed not collected) and Will Call. The
paid test must be an explicit method whitelist, never "has a payment row".

## Invoice total composition — verified on 8,311 of 8,311 orders

```
Total = Subtotal
      − DiscountAmount − DiscountCouponAmount
      + TaxAmount
      + Freight + Handling + Advertising
      + Delivery + Service + Relay + Fuel
      + AdjustmentsAmount
```

Reconciles **100%** (8,311/8,311, ±$0.01). `Subtotal` also equals the sum of
`OrderDetail.Total` on all 8,311. Any simpler rule fails: lines-only matches
1,931; lines + tax matches 7,046; lines + tax − discount matches 7,277. The
gap is `Delivery` and `Service`, which are header-only charges with no line.

Period sums for the invoiced set:

| Component | Amount |
|---|---:|
| Subtotal (= sum of line totals) | $1,297,844.32 |
| Tax | $42,695.24 |
| Discount | −$3,660.16 |
| Delivery | $36,525.44 |
| Service | $644.60 |
| Relay, Fuel, Freight, Handling, Advertising, Coupon, Adjustments | $0.00 / NULL |
| **Total** | **$1,374,049.44** |

`Fuel` and `AdjustmentsAmount` are NULL, not zero — coalesce or the arithmetic
silently yields NULL.

## Field mapping

### `CanonicalInvoice` — House Account orders

| Canonical field | Source | Notes |
|---|---|---|
| `invoiceNo` | `OrderHeader.InvoiceNumber` | 8,311 rows, 8,311 distinct, 0 blank, 0 pre-1990 dates. Equals `OrderNumber` in every sample. Clean natural key for QBO `DocNumber` and for payment matching. |
| `date` | `OrderHeader.InvoiceDate` | the CPA's basis. One invoice is future-dated (2026-08-26) — do not filter it out. |
| `dueDate` | derive from `TermsID` (`Net Due`) | single term across all rows |
| `customerName` | `CustomerInformation.CustomerName` | 1,311 invoiced orders join to a customer whose name is blank or `-` → clearing customer, see below |
| `lines[].itemName` | `OrderDetail.ItemID` | 2,432 distinct |
| `lines[].description` | `OrderDetail.Description` | |
| `lines[].qty` | `OrderDetail.OrderQty` | |
| `lines[].rate` | `OrderDetail.ItemUnitPrice` | |
| `lines[].amount` | `OrderDetail.Total` | sums to `Subtotal` exactly |
| extra lines | `Delivery`, `Service`, `TaxAmount`, `DiscountAmount` | header-only charges; each needs its own QBO line/field or the invoice will not tie |
| `freight` | `OrderHeader.Freight` | $0.00 across the whole period — carried for other tenants |
| `sourceId` | `CompanyID\|DivisionID\|DepartmentID\|OrderNumber` | the no-double-post key |

### `CanonicalPayment` — applied to the invoice above

| Canonical field | Source |
|---|---|
| `paymentNo` | `OrderNumber` |
| `date` | `OrderHeader.InvoiceDate` |
| `customerName` | as above |
| `amount` | `OrderHeaderPaymentMethodProcessingDetails.PaymentAmount` |
| `method` | `OrderHeader.PaymentMethodID` |
| `appliedToInvoiceNo` | `OrderHeader.InvoiceNumber` |
| `sourceId` | same four-part key, suffixed `:pay` |

Casing is dirty — both `Check` and `check` exist. SQL collation is
case-insensitive so `IN ('Check')` catches both, but the adapter (TypeScript)
must normalise before comparing.

### Register-paid orders need a Sales Receipt — the one real gap

6,480 of the 8,311 invoiced orders (Offline POS Payment + Cash + Check) are
paid at the register. Posting them as Invoice + Payment nets A/R to zero but
leaves 6,480 invoices and 6,480 payments cluttering QBO, and misrepresents a
counter sale as credit extended. AB#772 states the same requirement
independently: *register-paid orders must post as Sales Receipts, not Invoice/AR*.

**`core/contract.ts` has no `CanonicalSalesReceipt`.** It carries Invoice, Bill,
CreditMemo, Payment and JournalEntry. Adding it is a prerequisite for Berkeley,
not a nice-to-have — tracked separately (see below).

Payment amount equals order total on **6,476 of 6,480** register-paid orders.
The 4 exceptions need a rule before backfill.

## Configuration for the Berkeley tenant

| Setting | Value | Why |
|---|---|---|
| `product` | `quickflora-pos` | registry slot already reserved in `adapters/registry.ts` |
| `tenantId` | `BerkeleyFloristSupply33142` | Division/Department are both `DEFAULT` |
| `closingDateMode` | `block` | Maria has closed months; a five-month backfill must not land inside one |
| `autoCreateEntities` | `strict` | on `auto`, the 1,311 blank-name orders would create junk QBO customers |
| `clearingCustomerName` | e.g. `Berkeley Counter Sales` | absorbs those 1,311 anonymous walk-ins |
| `depositMode` | `undeposited` | groups register takings into daily deposits (AB#1225) |
| Backfill window | from **2026-03-06** | Berkeley's true start; `OrderHeaderHistory`, `EnterpriseArchive` and `Enterprise_Archive_Data` hold zero Berkeley rows, so this is genuinely all of it |

## Open decisions

1. **Sales Receipt entity** — must be added to the contract before Berkeley can
   go live. Blocks 6,480 of 8,311 orders.
2. **`Credit Card` (23 orders, $2,795.00)** — a sixth payment method distinct
   from `Offline POS Payment`. Sales Receipt or Invoice + Payment?
3. **2,432 items** — create all of them in QBO, or roll lines up to a handful of
   sales categories? Affects whether QBO's item list stays usable.
4. **Sales tax** — three groups (`default` ~6.88%, `non-taxable`, `fl-sales-tax-7`
   at 7%). Map to QBO tax codes, or post tax as a plain line? A plain line ties
   to the penny but breaks QBO's own tax reporting.
5. **`Delivery` ($36,525.44) and `Service` ($644.60)** — which QBO income
   accounts do these land in? Maria's call.
6. **The 4 register-paid orders where payment ≠ total** — partial payment,
   overpayment, or data error?
7. **50 `Wire_Out` orders** — outgoing wire-service orders; own treatment needed.
8. **929 uninvoiced orders** — confirmed out of scope for v1; they acquire an
   invoice number later and get picked up on a subsequent run.
9. **Berkeley chart of accounts (142 accounts) → QBO** — the account map. Ved
   owns the legacy chart's meaning.
10. **GL out of balance by $434.13** — harmless for the invoice route, blocking
    for any future GL route.

## Guardrails

- **Dry run before every backfill.** `dryRun` exists on all pushes (AB#1221).
  The 2026-08-08 incident — six journal entries posted three times because
  `qb_push_log` was missing a column and dedupe failed *silently* — happened on
  a far smaller dataset than a five-month, 8,311-order backfill.
- **Sandbox first.** Prove the full five months against realm 9341456826660683
  (`florachain-quickbooks-demo`) before touching Berkeley's live QBO company.
- **Tie out to Maria's numbers by `InvoiceDate`.** June 2026 register-paid is
  the known-good check: 995 orders / $109,334.27 by `InvoiceDate` matches her
  figure exactly; `OrderDate` (1,003 / $109,402.84) and `OrderDueDate`
  (1,004 / $109,409.56) do not.
- **Read-only, always.** No write of any kind to `Enterprise`.
