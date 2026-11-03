# AGING — choose SIGNED checks for release by how overdue their bills are

Date: 2026-10-15. Client request: "can we incorporate aging in checks monitoring. those with checks
only … this module can be use to select checks for releasing … check aging in supplier portal.
Follow the bucket."

## Purpose

Finance builds each release run by choosing which SIGNED checks go out next, and today does it in
Excel (the FOR RELEASE list, whose LOCAL sheet totals its overdue buckets). AGING is that choice
made in the app: SIGNED checks grouped into the Supplier Portal's aging buckets, ticked, and moved
to READY FOR RELEASE in one act — so the portal is told by the path it is always told by.

## Decisions (user, 2026-10-15)

1. **The action is MARK READY FOR RELEASE.** Only SIGNED checks are listed, because SIGNED is the
   only status that may move to READY_FOR_RELEASE (`lib/domain/check-status.ts`). SIGNATURE_PENDING
   is not shown.
2. **A module of its own**, `/aging`, on the module bar after CHECK RELEASE.
3. **The Supplier Portal's buckets, on the portal's axis — days past DUE DATE.**
4. **A check's due date is the EARLIEST due date of the bills it pays**; a check with none is
   **NO DUE DATE**.

## The buckets — copied from the Supplier Portal

`Supplier Portal/src/aging/store.js`, `bucketOf(daysPastDue)`:

| Key | Label | Days past due |
| --- | --- | --- |
| `current` | CURRENT | ≤ 0 (not yet due, or due today) |
| `b30` | 1–30 DAYS | 1–30 |
| `b60` | 31–60 DAYS | 31–60 |
| `b90` | 61–90 DAYS | 61–90 |
| `b90plus` | OVER 90 DAYS | > 90 |
| `noDue` | NO DUE DATE | no due date known |

Days past due = Manila today − the due date's Manila day, whole calendar days (the `manilaDay`
reduction in `lib/forecast/buckets.ts`, so a due date stored at UTC midnight and one at Manila
midnight agree). **OVERDUE** = `b30 + b60 + b90 + b90plus`.

Never-aging terms, copied from the portal's `neverAges` (`Supplier Portal/src/data/due.js`, user
ruling there 2026-10-08): a bill whose terms code, with every space removed and upper-cased, starts
with `COD`, `PDC`, `DATCHECK`, `DATEDCHECK`, `100PBD` or `100BPD` is CURRENT for as long as it is
open, whatever its due date says.

The rule lives in one pure module, `lib/aging/buckets.ts` — `ageCheck(bills, now)`. It is a separate module from `lib/forecast/buckets.ts`: the
forecast's buckets answer a different question (how long a check has been presentable) and stay.

### A check's due date

A check pays one or more bills (`Check.apvNumbers`). For each APV the due date and terms are read
from Acumatica (below); a bill with a never-aging term contributes no due date. The check's due date
is the **earliest** remaining one — the most overdue bill decides the bucket. Then:

- at least one dated bill → bucket from the earliest date;
- no dated bill, but at least one never-aging bill → CURRENT;
- otherwise (no APV, or no due date known for any of them) → NO DUE DATE.

Fallback, per APV only when Acumatica gives no due date: `CheckBill.dueDate` / `termsCode` from the
approval workbook for that `(check, APV)`.

### Where it will differ from the portal (stated, accepted)

- The portal ages **open bill balances**; AGING ages **SIGNED checks' amounts**. Same buckets,
  different money — the totals are not expected to agree.
- The portal derives a LOCAL bill's due date itself (APV date + the first integer in its terms, a
  vocabulary, then the supplier's default) and an IMPORTED one as approval + 30. AGING takes
  **Acumatica's own `DueDate`** for the bill ("follow Acumatica"). Where the portal's derivation
  and Acumatica's terms disagree, a bill can sit one bucket apart on the two screens.

## The data: due date and terms from Acumatica

`AP-Bills and Adjustments` is already read by BILL_REFS (`lib/sync/bill-refs.ts`) for the Vendor
Ref. That read also stores each bill's due date and terms.

- **To measure first (plan task 1):** whether the inquiry publishes `DueDate` and `Terms` on both
  tenants, and under which names — one read-only `$top=5` GET per tenant, no write. If either
  tenant lacks them, stop and report; the fallback design is `CheckBill` only, everything else NO
  DUE DATE, and goes back to the user before building.
- **A new table, `AcumaticaBillTerms`**, not new columns on `AcumaticaBill`. `AcumaticaBill` holds a
  row only for a bill with a non-blank Vendor Ref, and every PO reader treats a row as "this bill
  names a PO"; widening it to blank-ref bills would put empty POs on screens that are right today.

  ```
  model AcumaticaBillTerms {
    apvNumber      String    @id      // ReferenceNbr, trimmed, upper-cased
    tenant         String              // GOLIVE | MANUFACTURING, last writer
    dueDate        DateTime?           // Acumatica DueDate, a day (dayOnly)
    termsCode      String?             // Acumatica Terms, trimmed, verbatim
    lastModifiedOn DateTime?
    updatedAt      DateTime  @updatedAt
  }
  ```

  Reference data, like `AcumaticaBill`: no `Check` relation, no audit row per bill. A row is written
  for every in-scope Bill / Prepayment the read sees (same `BILL_REF_TYPES`, same 2024 scope), and
  updated when either value changes. Nothing deletes a row: a bill's terms do not stop existing.
- **No new SyncRun mode.** The same BILL_REFS run writes both tables from the same fetched rows, so
  one watermark covers both. `--bill-refs --dry-run` reports the terms counts too; `--bill-refs`
  snapshots `AcumaticaBillTerms` beside `AcumaticaBill` first.
- **The first fill** is `npx tsx scripts/sync.ts <TENANT> --bill-refs --full` on each tenant, run by
  the user after the migration reaches production. Until then every check is NO DUE DATE except
  those with a `CheckBill` due date, and the page says how many are NO DUE DATE.
- Rule 3 is untouched: the read uses the existing read-only client.

## The screen — `/aging`

Every Finance user (`requireUser()`), like the other modules; module id `AGING`.

**Population:** `status = SIGNED`, `isCheque = true`, an amount recorded (`isIncomplete = false`),
narrowed by the filters. Nothing else — a check at any other status is never listed or totalled.

**Filters:** the table kit's per-column filters, held in the browser as on TRANSMITTAL (COMPANY,
BANK and BUCKET are dropdowns; CHECK NO., CV, APV, PO, PAYEE text; dates and AMOUNT ranges). An
unreadable box is marked red and matches nothing; it never widens. The population is about 1,400
checks and is loaded whole.

**Top: the bucket strip.** One card per bucket — label, check count, amount (decimal strings,
centavo-exact, rule 8) — plus OVERDUE (the four overdue buckets) and ALL. A card sets `bucket`;
ALL clears it. The strip always counts the whole filtered population, so a card's count is the row
count its table shows.

**Below: the table**, built on the table kit (`lib/table-kit/`, `components/table-kit/`) like the
transmittal picker — sort, per-column filter, show/hide/reorder. Columns: ☐, CHECK NO., CV, APV,
PO NUMBER (`displayPoNumbers`), PAYEE, COMPANY, BANK, CHECK DATE, DUE DATE, DAYS PAST DUE, BUCKET,
AMOUNT. Default order: days past due descending (NO DUE DATE last), then check number. Row links to
the check page.

**Selection and release:**
- Tick rows, or SELECT ALL SHOWN (every filtered row of the bucket in view). Beyond
  `caps.bulkSelection` the SELECTED bar says so and MARK READY FOR RELEASE is disabled.
- A SELECTED bar shows count and amount, so a run can be built to a budget.
- MARK READY FOR RELEASE asks for the AVAILABLE PICKUP DATE and confirms
  (`Mark N check(s), PHP X, READY FOR RELEASE?`), then calls the existing
  `bulkReadyForReleaseAction` (`app/checks/bulk-actions.ts`) unchanged — the same domain rule
  (`markReadyForRelease`, required fields incl. CASH ACCOUNT / CHECK BOOK), the same audit row, the
  same MARK_AVAILABLE outbox event and kick, the same per-check refusal report. **No new write path.**
- After the run the page shows the result report and re-reads: readied checks leave the list.

**Export:** EXPORT EXCEL (`/api/export/aging`): every SIGNED check in the population, no filters.
A SUMMARY sheet (bucket × count × amount, then bucket × bank) and one sheet per non-empty bucket
with the table's columns. The title block says "ALL SIGNED CHECKS". Read-only.

**Stated on screen:** "SIGNED checks only. Aged by the earliest due date of the bills each check
pays, as in the Supplier Portal." and the NO DUE DATE count with a link to that bucket.

## Units

| Unit | Does | Depends on |
| --- | --- | --- |
| `lib/aging/buckets.ts` | `neverAges`, `daysPastDue`, `bucketOfDays`, `ageCheck`. Pure. | `manilaToday` |
| `lib/integrations/acumatica/bill-refs.ts` | `BILL_REF_COLUMNS` gains `dueDate`, `terms`; `mapBillRef` returns them. Pure. | — |
| `lib/sync/bill-refs.ts` | Also upserts `AcumaticaBillTerms`; snapshot covers it. | Prisma |
| `lib/aging/query.ts` | The population, each check's bills' terms (`AcumaticaBillTerms` ∪ `CheckBill` fallback), bucketed rows, the strip's totals. | Prisma, `buckets.ts`, `accountWhere`, `displayPoNumbers` |
| `lib/aging-picker.ts` | Kit columns, row values, strip totals (PHP only), selection total. Pure. | table kit types |
| `app/aging/page.tsx`, `components/AgingPicker.tsx` | The screen; selection; calls `bulkReadyForReleaseAction`. | table kit |
| `app/api/export/aging/route.ts`, `lib/export/aging-workbook.ts` | The extract. | `query.ts` |
| `lib/module-nav.ts` | `AGING` entry. | — |

Migration: one, `AcumaticaBillTerms`, timestamped after every migration on master and on the open feature
branches (`feature/self-registration` adds its own). It must reach
production BEFORE the deploy — `/aging` queries the table on every request.

## Testing

- `aging/buckets` (pure): every bucket edge (0, 1, 30, 31, 60, 61, 90, 91), Manila day boundary,
  each never-aging prefix with and without spaces, earliest-of-several, never-aging + dated bill,
  only never-aging → CURRENT, none → NO DUE DATE.
- `integrations/acumatica-bill-refs`: DueDate/Terms mapped, absent → null.
- `sync/bill-refs`: terms rows written for blank-ref bills too; `AcumaticaBill` unchanged for them;
  update on change; dry run writes nothing.
- `aging/query`: only SIGNED + isCheque + amount; filters; `CheckBill` fallback used only when
  Acumatica has no date; strip totals equal the table's rows, centavo-exact.
- `aging/picker`: strip totals centavo-exact and PHP only; bucket choice; selection total.
- `export/aging-route`: auth, refusal answers 400, sheet per bucket.
- `module-nav`: AGING entry.
- Readying goes through `bulkReadyForReleaseAction`, whose tests already cover the write.
- `npx tsc --noEmit`, `next build`, and a browser check against the TEST database
  (`scripts/dev-test-db.mjs`).

## Not in scope

- Ageing READY / SCHEDULED / RELEASED checks (`/forecast` and `/recon` cover those).
- SIGNATURE_PENDING checks, shown or selectable.
- Reading anything from the Supplier Portal (rule 12: the client sends only). The buckets are copied
  as a rule, not fetched.
- Changing `/forecast`'s buckets.
- Any status change other than SIGNED → READY_FOR_RELEASE through the existing action.
