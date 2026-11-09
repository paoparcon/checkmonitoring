# Monthly bank reconciliation — design (2026-11-09)

Client request 2026-11-09: enhance the existing Bank Reconciliation module (not replace it) into a
continuous monthly cycle — beginning balances, monthly transactions, outstanding checks carried
forward, ending balances becoming next month's beginning, under review/approval controls.

## What existed (reviewed first)

- `/recon` (OUTSTANDING CHECKS, 2026-09-12): released-and-not-cleared checks as of a day, per
  account (`lib/recon/outstanding.ts`, `summary.ts`, `query.ts`), with an Excel extract.
- `/clearing`: marks RELEASED checks CLEARED from a paste or a bank file via `recordClearing`.
- No balances, periods, statement lines, approval or history.

All of it is kept. `/recon` keeps its URL, filters and export; it gains a tab bar.

## The account

A reconciliation account is what `accountWhere` already calls one: a **CheckBook, else a
CashAccount**. No bank-account table is created. Every new row names exactly one of the two
(CHECK constraint) and repeats its id in `accountKey`, so one unique index serves both kinds.

## Tables (migration `20261109000000_monthly_bank_reconciliation`, additive only)

| Table | Purpose |
| --- | --- |
| `ReconOpeningBalance` | One per account. Effective date (the 1st of the first month), separate bank and book balances, currency, required reference, optional supporting document. |
| `ReconPeriod` | One per account per month. Status, beginning balances and their source (OPENING / CARRIED_FORWARD + `previousPeriodId`), statement beginning/ending balance, and — on approval — frozen figures plus the full computation in `snapshot`. |
| `ReconStatementLine` | Uploaded statement lines. `fingerprint` unique per **account** (the same line can never be counted twice, in any month). `checkId` unique (a check clears on one line). Kind: CHECK, BOOK_ENTRY, BANK_CHARGE, BANK_CREDIT, UNIDENTIFIED_DEBIT/CREDIT, BANK_ERROR. |
| `ReconBookEntry` | Book deposits and non-check disbursements (checks come from the check records). |
| `ReconAdjustment` | Other adjustments, BANK side (carries until resolved) or BOOK side (its month only). |
| `ReconReopenRequest` | Maker–checker re-opening; one PENDING per period. |

Every FK is RESTRICT. Amounts are `Decimal(18,2)`, decimal strings in code, centavo arithmetic (rule 8).

## Computation (`lib/recon/monthly/compute.ts`, pure)

Nothing is carried by copying. Each reconciling item is decided by its own dates against the
month's last day, so carry-forward is complete and duplicate-free by construction:

- **Outstanding checks** — `isOutstandingAsOf` (the rule `/recon` uses): released by month end,
  not cleared by it. A check stays outstanding month after month until cleared or voided. It is
  "released" (a book deduction) only in the month it was issued, and never in a reconciliation month
  if issued before the beginning balance date (it is inside the opening book balance).
- **Deposits in transit** — DEPOSIT entries dated by month end whose matched line is later (or none).
- **BANK adjustments / BANK_ERROR lines** — open from their month until the month resolved.
- **Bank charges, unrecorded credits, unidentified lines, BOOK adjustments** — their own month only.

```
Bank statement ending balance + deposits in transit − outstanding checks
  − outstanding non-check disbursements ± other bank adjustments = ADJUSTED BANK
Book ending balance + bank credits not recorded − bank charges and unrecorded debits
  ± other book adjustments = ADJUSTED BOOK
Reconciled ⇔ ADJUSTED BANK = ADJUSTED BOOK (to the centavo)
```

`explainVariance` lists the facts known to produce a difference: statement lines that do not foot,
statement beginning ≠ carried beginning, manual matches at another amount, checks cleared but not on
the statement, unidentified lines, checks outstanding from before the beginning balance, and any
single item equal to (or half of) the difference.

## Carry-forward

Next month's **beginning bank** = previous month's statement ending balance (the bank's own figure);
the timing differences carry beside it as items, never folded in. Next month's **beginning book** =
previous month's ending book balance **after** its reconciliation adjustments (= its adjusted book
balance) — bank charges, credits and book corrections identified in a month are deemed booked.

Approval opens the next month automatically when it has begun (else OPEN <MONTH> on the dashboard).
If the next month already exists in DRAFT (the month was re-opened and re-approved), its beginning
balances are re-carried, audited. A mismatch between a month's beginning and its source is shown
(dashboard and page), never silently repaired; a DRAFT month offers RE-CARRY.

## Statement matching

Upload .xlsx / CSV → preview (writes nothing) → CONFIRM re-reads and re-matches the same file.
Header found by its words (DATE + DEBIT/CREDIT or signed AMOUNT; DESCRIPTION, CHECK NO., REFERENCE,
BALANCE optional). Numeric dates read in the order that lands inside the month, refused if
ambiguous. BEGINNING/ENDING BALANCE rows feed the statement balances.

AUTO check match: number (check-number cell, else a standalone 6–13 digit number in the text,
leading zeros ignored) names a check of THIS account, amount equal, line not before the check's
issue day, RELEASED, period currency, not cleared on another day, not claimed by another line.
Payee is shown, never decides. It clears through `recordClearing` (cleared date = line date). Book
entries match on direction, amount and a 10-day window, exactly one candidate. Otherwise charge /
interest words classify; the rest are UNIDENTIFIED. Manual match or classification requires a remark.
A clearing is never undone, so a CHECK line cannot be re-classified.

## Control

DRAFT → FOR REVIEW (statement ending balance required) → FOR APPROVAL (reviewer ≠ submitter) →
RECONCILED (FINANCE_ADMIN ≠ submitter and ≠ reviewer; difference zero; previous month approved) →
CLOSED (FINANCE_ADMIN; previous month closed). RETURN to DRAFT needs a note. Only DRAFT is editable.
Approval freezes the figures and the computation; an approved month is read from the snapshot and
shows, without applying, any drift recorded since (e.g. a back-dated clearing).

Re-open: requested by a FINANCE_ADMIN with a reason, approved by a **different** FINANCE_ADMIN;
refused while the next month is past DRAFT. The beginning balance is editable (FINANCE_ADMIN, reason)
only while the first month is DRAFT. Every change writes a `recon_*` audit row with `periodId`.

## Screens

`/recon/monthly` dashboard (account, month, year, status filters; current month per account, or the
history), `/recon/periods/[id]` workspace, `/recon/balances`, `/api/export/recon-period?id=` report.

## Open questions for Finance

1. **Book basis.** The book side deducts a check when it is RELEASED (this system's record), as
   `/recon` always has. If the book balance typed in is Acumatica's GL — which credits cash on the
   payment date, released or not — signed-but-unreleased checks will appear as a difference.
2. **Historical outstanding checks.** Most released checks have no clearing recorded. An account's
   first month will list years of them as outstanding until cleared (statement upload or /clearing),
   and says so.
