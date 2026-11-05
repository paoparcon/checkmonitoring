# Check Release Monitoring

Internal Finance system for the RCL group (Starkson / A1+ and related companies). It tracks a
check from the moment Acumatica generates it until it is physically handed to a supplier:

```
ACUMATICA  →  CHECK RELEASE MONITORING  →  FINANCE CONFIRMATION  →  SUPPLIER PORTAL
```

The automation it exists for: **when Finance ticks READY FOR RELEASE, the Supplier Portal updates
without anyone re-encoding the check.**

Next.js 15 (App Router) · Prisma 6 · PostgreSQL on Neon (ap-southeast-1) · NextAuth v5 + argon2id ·
Vitest · TypeScript strict. Deployed on Vercel at `checkmonitoring.rclcompanies.com`.

## THIS SYSTEM IS THE RECORD. THE SPREADSHEET IS NOT.

Client decision, 2026-09-10: **"No more updating thru excel."** `CHECK MONITORING <date>.xlsx`
stops being maintained. The 9 September load was the last register import, and there should never
be another.

That is a change of premise, not a preference. Until now the spreadsheet was the real record and
this app was catching up to it; from here the app IS the record and the register is history.
It follows that:

- **Do not build anything that assumes a future register file.** No incremental register import,
  no watcher, no re-import path. `scripts/import-workbook.ts` stays for the historical load it
  performed and for seeding a fresh database; it is not part of the routine.
- **The Acumatica sync is now the only way a check arrives**, which makes it load-bearing in a
  way it was not before. While Excel was maintained, a sync nobody ran meant stale data with a
  paper fallback. Now it means the check does not exist. **A scheduled sync is a prerequisite
  for switching the team off the spreadsheet**, not an improvement for later.
- **The approval workbook is NOT covered by this decision.** `APPROVAL FOR RELEASE <date>.xlsx` is
  exported from Acumatica rather than typed by hand — a report, not a parallel record. It
  continues, and `lib/import/bills.ts` continues with it.
- **Anything Finance used to type into the register must be typeable here**, or somebody will
  reach for Excel out of necessity and the two records will diverge again. The register carried
  remarks, point person, who is holding the check, and clearing details. The columns exist;
  each needs to be reachable on screen. **Built 2026-09-11:** remarks, point person, who is
  holding it and category are edited on the check page (FINANCE NOTES); the bank's clearing is
  recorded there on a RELEASED check or in bulk on `/clearing` from pasted statement lines;
  `NONE → CLEARED` is legal, because a statement is proof of clearing whether or not a deposit was
  recorded first.
- Where the two disagreed, **the register was wrong** — 94 amounts and 1,958 company assignments,
  measured below. That is the strongest argument for this decision, and worth repeating to
  anyone who wants the spreadsheet back.
- **Finance kept filling the register anyway, and one catch-up has been run.** Measured
  2026-09-24: `CHECK MONITORING 9.24.2026.xlsx` records **698 pick-ups since 9 September** that
  were never ticked here. On the user's request, `scripts/backfill-released-from-register.ts`
  (`lib/admin/register-releases.ts`) moved **940 checks to RELEASED** — 398 SIGNED, 359
  SIGNATURE_PENDING, 183 READY_FOR_RELEASE; Acumatica said 528 Closed, 403 Balanced, 9 unknown.
  Status only, one `backfilled_released_from_register` audit row each carrying the sheet, row
  and the register's DATE RELEASED verbatim; `releasedAt`/`releasedById` stay null; snapshots in
  `snapshots/`. It left 61 CANCELLED/VOIDED here and **252 check numbers the app does not hold
  at all** (mostly STK P&P / MBTC P&P RELEASED) — nobody has yet found out why the sync never
  brought them. **Matching is on check number; the register's company only breaks a tie** —
  1,690 of its released numbers exist here exactly once under the company Acumatica assigned
  (STPP→STK 681, A1+→STK 536, A1PP→A1+ 322), and letting the register's company veto them
  matched only 312 of the 940. This is a catch-up, not a routine: every further run means
  releases are still happening outside the app, which is the problem to fix, not the script.
- **The for-release list changed shape on 2026-09-24, and `lib/import/bills.ts` cannot read it.**
  `FOR RELEASE 9.25.2026.xlsx` has `Detail1` (pivot drill-down, header on row 3, 939 vouchers all
  remarked AVAILABLE, no check number), `LOCAL` (BANK column first, header on row 2, 192),
  `BROKERS` (register-shaped, 42 checks) and `PIVOT`. `isBillSheet` reads none of them.
  **User ruling 2026-09-24: all three sheets are the list.** `scripts/mark-ready-from-release-list.ts`
  (`lib/admin/release-list.ts`) finds a voucher or CHECK NUMBER header in rows 1-3 of each sheet,
  resolves each voucher to **exactly one live check** via `apvNumbers` (or the broker row's check
  number), and moved **522 checks to READY_FOR_RELEASE** (387 SIGNED, 135 SIGNATURE_PENDING) — 572
  ready after. Status only; no `readyAt`/`readyById`/pickup date, no portal event, **no `CheckBill`
  row** — so **never run `scripts/backfill-available.ts` after it**: that script reads "has a bill"
  as "on the list" and would demote all 522. Left alone: 336 vouchers naming no check, 14 naming
  only cancelled/voided ones, 5 naming two live checks, and **24 the list calls available that the
  9.24 register shows released on 21-22 September** — kept RELEASED; a stale list does not pull a
  release back. Nothing was demoted: the one READY_FOR_RELEASE check off the list (`6000352027`)
  was not released in the 9.24 register, and the user's instruction was to demote only on that.
  **Superseded 2026-09-25: the list is LOCAL + BROKERS only.** The 71.08M the app then showed as
  available did not match Finance's 20.47M, because `Detail1` is the PIVOT's drill-down ("Details
  for Sum of Detail Total - FINANCE REMARKS: AVAILABLE" — every bill Acumatica remarks AVAILABLE,
  117.8M), not the list; the PIVOT sums only LOCAL (11,657,821.01) and BROKERS (9,469,750.00).
  Finance's 20,471,260.80 uses LOCAL's row-1 11,001,510.80, the sum of the four overdue buckets
  only. The 428 checks named only by `Detail1` (57,160,884.23) were NOT released — all sat on the
  9.24 register's AVAIL./unreleased sheets, 409 Balanced in Acumatica — and
  `scripts/revert-detail1-ready.ts` returned them to their prior status (352 SIGNED, 76
  SIGNATURE_PENDING; one `ready_reverted_detail1_not_release_list` audit row each, snapshot in
  `snapshots/`). After: 143 available, 13,922,609.81. `readReleaseList` now skips a sheet titled
  "Details for …". The rest of the gap to the list: 90 LOCAL vouchers (6.91M) name no check here,
  2 (256,160.00) name two live checks. 11 of the 428 carry a `CheckBill`, so
  `scripts/backfill-available.ts` would re-promote them — another reason never to run it.
  The same day, on the user's instruction, the two LOCAL checks READY here but `Voided` in
  Acumatica (`6000353108`, 6,000.00; `1791404779`, no amount) were voided through `voidCheck`,
  snapshot first. Available after: 142, 13,916,609.81.
  ~~Leave the 90 LOCAL vouchers with no check here, as not yet processed~~ — **wrong, and
  superseded the same day.** Read from Acumatica's `AP-PAYMENTS-WITH-BILLS`, every one of the 90
  was paid by exactly one live check this system already held at SIGNED; the link was missing
  because `apvNumbers` came only from the retired register and `AP-Checks and Payments` publishes
  no bill reference. **A voucher that "names no check here" means an unlinked check, not an
  unprocessed bill — look it up before concluding anything.** `scripts/link-vouchers-from-acumatica.ts`
  (`lib/admin/voucher-links.ts`: exactly one live CHK check, voided and ADR applications ignored,
  a list-stated check number must agree) linked 130 list vouchers (90 LOCAL, 40 BROKERS) — one
  `voucher_linked_from_acumatica` row each — and moved the 90 SIGNED checks to READY_FOR_RELEASE,
  snapshot first. Available after: **233, 21,013,221.48**; 0 list vouchers unlinked. The bill
  column is `AdjdRefNbr` in Go-Live and `ReferenceNbr_2` in MANUFACTURING (a filter on the Go-Live
  name is a 500 there), and an `or` of several `eq` filters is a 500 in Go-Live. **Since 2026-10-01 the scheduled run reads it** (`lib/sync/bills.ts`, `runScheduledBillsSync`, `SyncRun.mode = 'BILLS'`; feed in `lib/integrations/acumatica/bills.ts`, `BILL_FEED_COLUMNS`): every `CHK` → `Bill` application is unioned into the paying check's `apvNumbers`, matched on the payment's own reference (`acumaticaPaymentId`), add-only, never status. The first read is `npx tsx scripts/sync.ts <TENANT> --bills` from a terminal (it snapshots to `snapshots/bills-<tenant>-<timestamp>.json` first; `--dry-run` reads and writes nothing). The run message names up to 10 payments the inquiry shows that are not held here, because the watermark moves past them for good — `scripts/sync.ts <TENANT> --bills --full` relinks them once their checks exist (idempotent, add-only). **That was not enough (2026-10-26): `CV-HF000161` (`6000354602`, HAMFI) was released on 23 Oct with no APV and its RELEASED event parked** — a manual full BILLS read at 01:23 on 6 Oct read its application and moved the watermark past it, and the payment sync only created the check at 04:00; three HAMFI checks (CV-HF000161..163) sat that way for three weeks. User ruling: *"this should not happen again."* **Since then every incremental BILLS run also looks up, by payment reference, each held Acumatica check of the tenant that is a check, live or RELEASED, and still has no APV** (`lookUpApvLess` in `lib/sync/bills.ts`, `billsForPaymentFilter` — the tenant's own column; at most `DIRECT_LOOKUP_LIMIT` = 20 a run, oldest first, one request each; only that payment's applications are taken from the answer; add-only; a failed lookup is an error named in the message but never holds the feed watermark; a first read looks nothing up). The run message and `scripts/sync.ts --bills` print `N held check(s) with no APV looked up directly: M linked`. The backlog measured that day was four (the three HAMFI checks and `6000318443`, the first CASH check the full re-read created) — so the lookup, not a human, closes the gap for the CASH checks arriving now. **First reads done:** GOLIVE 2026-10-01 19:09 Manila (MANUAL) — 755 vouchers added to 755 checks, 3,343 payments in the inquiry not held here (not yet examined; most are expected to be outside the sync's 2026-and-CHK scope); MANUFACTURING 2026-10-02 11:38 Manila — 180 fetched, 52 not CHK → Bill, 22 vouchers added to 22 checks, 2 not held here, 0 errors, snapshot `snapshots/bills-MANUFACTURING-2026-10-02T03-38-32-602Z.json`. The cron runs BILLS for a tenant only after that tenant's payment read RAN (`SKIPPED_PAYMENT_NOT_RUN` otherwise, not a failure) — a failed payment read's checks would otherwise count as not held and be skipped for good. The watermark is held (the run finishes with none, so the previous one stays) when any check's write failed, and the problem names its payment reference. Only a check with something missing opens a transaction; a re-read of an already-linked set costs one lookup. `upsertCheck` now writes `apvNumbers` only when the merge adds a voucher, so the payment sync cannot erase a BILLS append. A check's PO NUMBER is `CheckBill.poNumber` ∪ the real POs Acumatica's `AP-Bills and Adjustments` names in `VendorRef` for any APV the check shows (spec `2026-10-05-po-from-acumatica-design.md`, client 2026-10-05 "only real POs"): `lib/sync/bill-refs.ts` mirrors it into `AcumaticaBill` (keyed by APV, reference data — no `Check` column, no audit row per bill, deleted when the ref stops naming a PO), `SyncRun.mode = 'BILL_REFS'`, its own watermark, run by the cron after BILLS for a tenant whose payment read RAN; the first read is `npx tsx scripts/sync.ts <TENANT> --bill-refs` (snapshot `snapshots/bill-refs-<tenant>-<timestamp>.json` first). `extractPoNumbers` (`lib/integrations/acumatica/bill-refs.ts`) keeps only the measured PO shapes; ONE column map serves both tenants for this inquiry. `displayPoNumbers` in `lib/queries.ts` is the one definition — list, Excel, print, PO sort, PO filter and search all read it or its SQL twin `acumaticaPoMatch`. The list, Excel and print show a PO NUMBER column (Excel AMOUNT moved to column 8; the column-choice storage key was then `check-monitoring.columns.v2`; since the table kit it is `check-monitoring.table.checks.v1`, migrated once from `check-monitoring.columns.v3`). **User ruling 2026-10-06 supersedes "only real POs": Acumatica's Vendor Ref STANDS AS the PO NUMBER, whatever it looks like** (`26P09-0420` is a PO number to Finance). `AcumaticaBill` keeps EVERY bill with a non-blank Vendor Ref (a row is deleted only when the ref goes blank), `loadAcumaticaPoIndex` and `acumaticaPoMatch` read `vendorRef` whole, and `extractPoNumbers` / `AcumaticaBill.poNumbers` are now diagnostic only — nothing displays or matches on them. There is no separate REFERENCE column (one was built and deployed the same day, then removed on request). **2026-10-06, user ruling: a PPM (prepayment) is linked like a Bill** (`BILL_SIDE_TYPES` in `lib/integrations/acumatica/bills.ts`; `BILL_REF_TYPES` adds `Prepayment` to the bill-ref read) — cargo, customs and brokerage checks (e.g. `6000354281`…) pay a PPM, so they had no APV and no PO. Full re-reads on both tenants linked 40 more checks (GOLIVE 40, MANUFACTURING 0), snapshots `snapshots/bills-<TENANT>-2026-10-06T01-2*.json`; 0 live Acumatica checks left with no APV. Consequence the user accepted: those checks now carry an APV, so the portal outbox may send events for them. **SYNC NOW also runs the BILLS and BILL_REFS reads** (`syncNowAction`), because a check first read manually used to wait for the next cron with no APV and no PO. **Run 2026-10-06 by the user, `--bill-refs --full` on both tenants, 0 errors: GOLIVE 15,919 fetched, 3,050 ignored, 7,662 naming a PO shape, 5,207 not, 5,335 rows written, 0 deleted; MANUFACTURING 217 fetched, 56 ignored, 72 / 89, 92 written, 0 deleted** — so every bill's ref is already stored.
  **Scope widened 2026-10-06 (user request): the bill-ref read now starts at bills dated 2024-01-01, not 2026** (`IN_SCOPE_FROM`, `lib/integrations/acumatica/bill-refs.ts`) — a 2026 check pays older bills (`AP-A1030212`, dated 2025-10-29, had no PO on the transmittal; 40 of 1,332 SIGNED/PENDING checks had no stored ref). The incremental read looks only at recent `LastModifiedOn`, so the older bills arrive only with `--bill-refs --full` on each tenant (run by the user; not run by Claude).
  **`FOR RELEASE 9_1.25.2026v2.xlsx`** (same day): LOCAL unchanged; BROKERS 39 checks / 8,174,750.00,
  with a new SCM REMARKS column (DELIVERED …), unused. Added `6000354012` and `6000354067` (linked
  and readied by the link script). Dropped `6000354001`/`05`/`06`/`13` (2,285,000.00) — **user
  ruling: dropped off the list = pulled, not released** — back to SIGNED, one
  `ready_reverted_off_release_list` row each, snapshot first. This reverses the 2026-09-10
  "dropped = released" reading for this list; ask each time rather than assume either. App after:
  **231 available, 19,724,221.48**, exactly the list's checks; 0 off-list.
  **Second register catch-up, 2026-09-26**, on the user's request: `CHECK MONITORING 9.25.2026.xlsx`
  showed 240 pick-ups not RELEASED here — 228 dated 25 Sep, 12 dated 18-24 Sep that were typed
  after the 9.24 file — all Balanced in Acumatica; 160 were READY_FOR_RELEASE, 80 SIGNED. All 240
  moved to RELEASED by `backfill-released-from-register.ts`, snapshot first. Available after:
  **71, 3,162,018.70**. Still 252 register check numbers the app does not hold, and 78 it holds as
  CANCELLED/VOIDED, both left.
  `6000352027` (2,180.36, on no sheet of the 9.25 list) was confirmed released by the user and set
  RELEASED — status only, `released_confirmed_by_user` audit row, snapshot first. Available after:
  141, 13,914,429.45 — every one of them on LOCAL or BROKERS. Then `6000353477` (Voided in
  Acumatica) was voided, and its re-issue `6000353478` and `1791404780` — the live checks of the
  two LOCAL vouchers that had named two — were moved SIGNED → READY_FOR_RELEASE on the user's
  instruction. Available after: 143, 14,168,302.31. **LOCAL's own total is wrong**: S1's
  11,001,510.80 sums `O3:O185` while the data runs to row 194, missing 9 BPI P&P vouchers
  (656,310.21); the true total is 11,657,821.01, which the PIVOT agrees with. BROKERS row 29
  (`6000353108`, 6,000.00) is a check Acumatica voided — the list still calls it available.
  **User ruling 2026-09-25: follow Acumatica on voids.** `scripts/void-acumatica-voided.ts --apply`
  (run by the user) voided the 35 checks Acumatica reported Voided that were still live or
  RELEASED here — 18 SIGNED, 17 RELEASED (all imported from the register at RELEASED;
  `6000089687` keeps its supplier receipt and a `voided_after_release` row). 0 left after.

## Commands

```bash
npm run dev                    # local dev server — against PRODUCTION (DATABASE_URL)
node scripts/dev-test-db.mjs      # dev server on the TEST database (the repo .env is PRODUCTION); outward integrations blanked
npm test                       # full suite (Vitest, hits the TEST database)
npx tsc --noEmit               # REQUIRED before claiming done - see below
npx next build
npm run db:migrate             # dev migrations
node scripts/migrate.mjs test             # apply migrations to the TEST database (URL never touches a shell)
node scripts/migrate.mjs prod --confirm   # the same against PRODUCTION; migrate BEFORE you deploy
npm run db:seed                # dev seed, WITH demo checks and known-password accounts
npm run db:seed:reference      # production seed: reference data only, no checks, no accounts
npm run create-admin           # bootstrap the first FINANCE_ADMIN on a fresh database
npx tsx scripts/backfill-incomplete.ts --dry-run   # re-derive Check.isIncomplete; idempotent
npx tsx scripts/backfill-apv-numbers.ts "CHECK MONITORING 9.1.2026.xlsx" --dry-run  # fill Check.apvNumbers
npx tsx scripts/backfill-available.ts --dry-run                     # the approval list IS ready-for-release
npx tsx scripts/backfill-released-dropped.ts <older> <newer> --dry-run   # dropped off that list = released
npx tsx scripts/repair-cr-receipts.ts            # dry run: the register's CR numbers out of crNumber
npx tsx scripts/repair-cr-receipts.ts --apply    # snapshot to snapshots/, then repair, one audit row each
npx tsx scripts/backfill-released-from-register.ts "CHECK MONITORING 9.24.2026.xlsx"   # dry run: register pick-ups not yet RELEASED
npx tsx scripts/backfill-released-from-register.ts "<register>.xlsx" --apply           # snapshot, then status only, one audit row each
npx tsx scripts/backfill-stated-release-dates.ts "CHECK MONITORING 9.25.2026.xlsx"     # dry run: the register's DATE RELEASED onto RELEASED checks
npx tsx scripts/backfill-stated-release-dates.ts "<register>.xlsx" --apply              # snapshot, then statedReleaseDate only, one audit row each
npx tsx scripts/mark-ready-from-release-list.ts "FOR RELEASE 9.25.2026.xlsx"            # dry run: listed checks not yet READY_FOR_RELEASE
npx tsx scripts/mark-ready-from-release-list.ts "<for-release>.xlsx" --apply            # snapshot, then status only; never follow with backfill-available
npx tsx scripts/revert-detail1-ready.ts "<for-release>.xlsx" <ready-from-list snapshot> [--apply]  # Detail1-only READY back to prior status (run 2026-09-25)
npx tsx scripts/void-acumatica-voided.ts [--apply]                # void what Acumatica voided (live or RELEASED here)
npx tsx scripts/close-unmatchable-cancelled.ts [--apply]         # parked CANCELLED events whose check has no APV: close unsent
npx tsx scripts/detach-cancelled-apvs.ts [--apply]               # CANCELLED/VOIDED checks still on an AP bill: detach, close their open CANCELLED events (ruling 2026-10-29)
npx tsx scripts/reinstate-register-cancelled.ts [--apply --check <number>]   # CANCELLED by the register only, live in Acumatica: list; put NAMED ones back to SIGNED with their bills
npx tsx scripts/backfill-check-books.ts GOLIVE [--apply]       # record a missing check book from CashAccount; also moves or clears a book that differs from Acumatica's (§G1) (MANUFACTURING likewise)
npx tsx scripts/link-vouchers-from-acumatica.ts "<for-release>.xlsx" [--apply]  # link list vouchers via AP-PAYMENTS-WITH-BILLS, ready their checks
npx tsx scripts/sync.ts GOLIVE --bills --dry-run     # read AP-PAYMENTS-WITH-BILLS, write nothing (MANUFACTURING likewise)
npx tsx scripts/sync.ts GOLIVE --bills               # snapshot, then union vouchers into apvNumbers; add --full to re-read
npx tsx scripts/sync.ts GOLIVE --bill-refs --dry-run  # read AP-Bills and Adjustments, write nothing (MANUFACTURING likewise)
npx tsx scripts/sync.ts GOLIVE --bill-refs            # snapshot AcumaticaBill, then mirror bill -> PO; add --full to re-read
npx tsx scripts/sync.ts GOLIVE --full               # snapshot, re-read every 2026 CHK payment, then the live checks that left that feed (--dry-run lists them)
npx tsx scripts/reconcile-with-acumatica.ts "<file>.xlsx" [--apply --user <email>]   # AFTER --full: Closed-in-Acumatica checks to RELEASED, Finance verdicts (2026-10-06)
npx tsx scripts/revert-recent-signed.ts 2026-10-19 [--apply --user <email>]   # SIGNED first read on/after that Manila day back to PENDING (signing manual, 2026-10-22)
npx tsx scripts/push-checks-to-portal.ts [--full] [--dry-run]   # push every check (status, APVs, detached APVs, dates) to the portal's All Checks list; --full re-sends all
```

**On Windows, use `npx.cmd` / `npm.cmd`.** PowerShell's execution policy is `Undefined` (i.e.
`Restricted`) and blocks `npx.ps1`.

## Rules that must not be broken

These are safety properties, not preferences. Each exists because of a specific failure.

1. **INTERNAL USE ONLY.** No supplier login, supplier dashboard, or supplier-facing page. Suppliers
   never log in here.
2. **An `INTERNAL` check never tells a payee anything.** Payroll, tax, fund transfers and
   inter-company payments are classified `INTERNAL` by `lib/domain/eligibility.ts`. Since user
   ruling 2026-10-19 (portal spec `2026-10-19-cm-internal-release-quiet-design.md`) the portal is
   sent their RELEASED, RELEASE_REVERSED and CANCELLED, flagged `internal: true`, so their bills
   stop aging there; the portal records them silently. MARK_AVAILABLE, REVERT and RECEIPT are never
   sent, and the check row never carries portal state (`check_internal_never_routes_to_portal`).
   The actions decide (`queuesQuietStatus`), and the portal client asserts it again
   (`INTERNAL_PORTAL_KINDS`). Two independent checks, deliberately. **Since 2026-10-29 CANCELLED is
   not sent for any check** — see "A cancelled or voided check is detached from its AP bills" below.
3. **Acumatica is read-only.** `lib/integrations/acumatica/client.ts` exposes no mutating method,
   and a test asserts it. Read-only by construction, not by callers being careful.
4. **An import never changes a check's status.** Acumatica does not know whether Finance has signed
   or released anything, so a sync that wrote `status` would silently undo a Finance user's work.
   The immutable field list is `IMMUTABLE_ON_UPDATE` in `lib/import/upsert.ts`, with an
   exhaustiveness test that fails when a new `Check` column is added and not classified.
5. **The portal may never mark a check RELEASED.** Physical release is Finance-only.
6. **No delete-user path exists anywhere.** A `User` is referenced by `AuditLog` and five `Check`
   relations; deleting one orphans the record of who released real money. Removal is deactivation,
   and the last active admin cannot be deactivated or demoted.
7. **Audit rows are append-only**, enforced by a database trigger. `app.allow_audit_purge` appears
   only in `tests/helpers/db.ts` and the trigger migration — anywhere else is a defect. The trigger
   has exactly one exemption, added in `20260905000100_audit_log_detach_on_check_delete`: the FK's
   `ON DELETE SET NULL` may blank `checkId` when the check it points at is already gone, and only
   when every other column is unchanged. Without it no check with any audit history could be
   deleted at all, because Postgres implements SET NULL as an UPDATE. Content stays unwritable.
8. **Amounts are decimal strings end to end.** Never a JS number. The column is `Decimal(18,2)` and
   float round-trips lose centavos.
9. **Never commit or print** the two `.xlsx` workbooks (real vendor names and amounts), `.env`, or
   any credential.
10. **A check is deleted only through `deleteIncompleteCheck`**, which refuses everything except a
   FINANCE_ADMIN removing a check with no amount that is not RELEASED, SCHEDULED or
   READY_FOR_RELEASE and carries no `releasedAt`. It writes the deletion's own audit row first, in
   the same transaction, because the detached rows would otherwise point at nothing. There is no
   bulk version and must not be one. Measured 2026-09-04: 98 of the 129 incomplete checks qualify;
   the other 31 (25 RELEASED, 6 READY_FOR_RELEASE) do not, and that is the answer, not a gap.
11. **A supplier's receipt is never written to `crNumber`.** The OR/CR box on the release form is
   the paper the supplier hands over when they collect — Official Receipt or Collection Receipt —
   and it lives in `orNumber` / `orDate` / `receiptType`. `crNumber` sits beside `clearingStatus`
   and `clearedDate` and holds the **bank's** clearing reference, recorded weeks later. The two
   abbreviate alike and mean nothing like each other: a receipt number in `crNumber` reads, to every
   report and every reconciliation, as evidence that the money cleared — for a check that was
   merely handed across a counter. `markReleased` and `recordReceipt` write only the three receipt
   columns; `recordClearing` is the only writer of `crNumber` — the one exception is the one-off
   repair below, which only ever sets it to null. Pinned by `tests/actions/receipt.test.ts`.
   **Since 2026-09-25 the list takes a receipt per ticked row** (`lib/row-receipts.ts`,
   `readRowReceipts` in `lib/receipt-form.ts`): ticking a READY FOR RELEASE, SCHEDULED or
   RELEASED-without-OR row opens that row's own OR / CR box; RELEASE and SAVE RECEIPTS
   (`bulkRecordReceiptsAction`) write through `markReleased` / `recordReceipt` only. The old refusal
   of one box for a batch is replaced, not loosened — every box now has one owner — and a receipt
   keyed to an unticked check, a number with no type, and the old unkeyed fields are all refused
   before anything is written.
   The **type is stored, not parsed back out of the reference** — "OR-000123", "4471" and "CR 88"
   are all references a supplier writes, and a prefix rule over them is a guess dressed as a fact.
   **This hazard happened at scale before the rule existed.** The 9 September load wrote 2,727
   values shaped `CR 1234` into `crNumber`, taken from the register's column headed **REMARKS** —
   because the sniffer classified any `CR <digits>` cell as a clearing reference on the prefix
   alone. Client ruling 2026-09-11: they are the supplier's **Collection Receipts**.
   `scripts/repair-cr-receipts.ts` moves them to `orNumber` + `receiptType = CR` (`crNumber` back to
   null, one `receipt_reclassified_from_register` audit row each, a JSON snapshot first), and the
   sniffer now reads such a cell as `RECEIPT_REF`, written on create to the receipt columns and
   never to `crNumber`. Every `crNumber` in production after the repair is one Finance typed.
    **Since 2026-10-02 the receipt also has an amount and a scanned file, both add-only.** The
    amount is `Check.receiptAmount` (`Decimal(18,2)`, sent to the portal as a 2-decimal string,
    never a JS number); the file (PDF/JPG/PNG, at most 3 MB, signature-checked) is stored in
    `CheckReceiptFile` (BYTEA) and read only when a RECEIPT is delivered. Once recorded neither is
    overwritten: `attachReceiptFile` adds a missing amount or file later and refuses to replace one
    that is there. **The one way out is `removeReceipt` (2026-10-23, REMOVE RECEIPT on the check page,
    FINANCE_ADMIN, reason required)**: for a receipt typed with a release that never happened
    (6000354897, AR 4852). RELEASED and uncleared only; refused when a RECEIPT event was DELIVERED to
    the portal (it has no remove message); clears the receipt columns, amount and file, one
    `receipt_removed` audit row. It exists to unblock REVERSE RELEASE, never to edit a real receipt.
    They travel to the portal as the `RECEIPT` outbox event, queued only for a
    portal-routed check with an APV (an INTERNAL or APV-less check records the receipt here and
    queues nothing). Server actions allow a 4 MB body (`bodySizeLimit` in `next.config.ts`).
    **The outbox has two lanes per check.** Status lane: MARK_AVAILABLE, REVERT, RELEASED,
    RELEASE_REVERSED, CANCELLED. Receipt lane: RECEIPT. Latest-wins supersedes within a lane only,
    so a RECEIPT never closes a status event. A RECEIPT is held until the check's newest
    status-lane event is SYNCED, across runs and while that event is PARKED. A RECEIPT settling
    never writes `Check.portalSyncStatus` or `portalTradeId`, and it is skipped when less than 6 s
    of the run remain (`lib/sync/portal-outbox.ts`); the receipt actions kick delivery with 25 s, the
    other actions with 8 s. Rollback is forward-fix only: Postgres cannot drop the `RECEIPT` enum
    value, so older code must not run while RECEIPT rows exist (review 2026-10-02).
12. **The portal client sends only.** Nothing reads a status from the portal into a check;
    `lib/integrations/portal/client.ts` has two methods, both send-only: `deliver` (one outbox
    event) and, since 2026-11-03, `pushChecks` (a batch of check rows for the portal's list).

## Things that will catch you out

**The dashboard has two screens, and the URL decides which** (`dashboardScreen` in
`lib/dashboard-view.ts`, client request 2026-09-25). A bare `/` is TOTALS — cards, TODAY'S
RELEASE, timeline, a search box — and loads no rows. **Since 2026-09-29 so is a URL carrying
only `company`, `cashAccount` or `eligibility`** ("should have filter in every summary", spec
`2026-09-29-totals-filters-and-all-checks-design.md`): the TOTALS screen has those three
dropdowns (`components/TotalsFilterBar.tsx`) and every figure on it narrows — `getSummary`,
`getTodaysRelease` and `listTodaysReleaseIds` take a `SummaryNarrowing`, so RELEASE ALL releases
the set the narrowed panel counted, and a filter value that is present but unrecognised REFUSES
the release rather than widening it. A card, `scope=all`, `incomplete=1`, a search, or
**`scope=live`** is LIST: a BACK TO TOTALS bar and the full-width table. `scope=live` is the
NEEDS ACTION list said out loud — the list's filter bar carries it on that view so filtering
inside the list cannot land on `/?company=…`, which is now the totals; it changes no filter. ALL
CHECKS (card id `TOTAL_CHECKS`, `scope=all`, labelled TOTAL CHECKS until 2026-09-29) is a primary
card and **keeps the filters** like every other card — it is the check inventory; it no longer
clears them, RESET does. Export and print read the same URL and know nothing about screens. A
link that should open the list must carry one of the LIST parameters; a bare `/` or a
company/bank/eligibility-only URL never shows a table. `dashboardScreen` fails closed: any
`base` key outside `TOTALS_KEYS` (company, cashAccount, eligibility) opens the LIST, and RESET
and the incomplete toggle write `scope=live` on NEEDS ACTION so they cannot land on the totals.
**Since 2026-10-01 (part C) a `sort`/`dir` pair and every `f.*` filter-row parameter are LIST
parameters too** — `dashboardScreen` counts `selection.sort`, and the `f.*` values ride in `base`.
The LIST screen's "EXCLUDING N WITH NO RECORDED AMOUNT" count is the list's own:
`countChecks({ ...filters, incomplete: true })`, every list filter (view, search, company, bank,
eligibility, DATE RELEASED and the filter row), so N is exactly what "Show them" opens. BACK TO
TOTALS keeps company, bank and eligibility via `totalsHref` — narrowing to STK, opening SIGNED
and coming back lands on STK's totals.

**DATE RELEASED on the filter bar matches either of two dates that are never merged**
(2026-09-28, specs `2026-09-28-released-date-filter-design.md` and
`2026-09-28-stated-release-date-design.md`). `releasedAt` is the app's own record of a
release and only `markReleased` writes it; `statedReleaseDate` is the day the retired
register states, written once by `scripts/backfill-stated-release-dates.ts` from the
RELEASED sheets of a register file (exactly one calendar day per check — an Excel date
cell or the text `MM/DD/YYYY`, which is how 222 of the 228 rows dated 25 September were
typed, nothing else parsed, and nothing before 2015 or after the run day; exactly one
RELEASED check per number; never overwritten; one `stated_release_date_from_register`
audit row each; snapshot first). **Run once, 2026-09-28, from `CHECK MONITORING 9.25.2026.xlsx`
on the user's go-ahead: 10,494 stated days written (228 of them 25 September), 0 raced,
snapshot `snapshots/stated-release-dates-2026-09-28T09-48-10-422Z.json`; left alone 66
VOIDED here, 25 with two days, 168 with no usable date (68 say CLEARED), 234 not held here.**
`releasedFrom` / `releasedTo` are Manila days, honoured
only on the RELEASED and ALL CHECKS views; the table shows the app timestamp or, failing
that, the stated day tagged REGISTER; the LIST screen counts the checks with neither. Do
not write the stated day into `releasedAt`, and do not read `statedReleaseDate` as "the app
recorded a release" — `lib/recon/outstanding.ts` deliberately reads only `releasedAt`.

**The list sorts, filters per column and reorders** (part C, 2026-10-01, spec
`2026-10-01-signing-schedule-apv-and-table-design.md`). **Sort:** the order in force is the URL's
`sort=<column>&dir=asc|desc`, else the `cm_sort` cookie (`<key>:<dir>`, a year, `SameSite=Lax`,
written in the browser on a header click), else the default — the cookie is never written into a
URL, and RESET clears both. It is server-side over every matching check, nulls last both ways,
with `id asc` as the final tiebreak so a page boundary is stable. APV, PO, BANK and DATE RELEASED
are ordered in the app over the FULL matching set (`APP_SORTED_KEYS`, `lib/list-sort.ts`) because
Prisma cannot order by them; every other key is `listChecks`'s `orderBy`. Export and print read the
same cookie. **Filters:** the `f.*` parameters (`lib/column-filters.ts`; COMPANY, BANK and DATE
RELEASED keep their old names). **An unreadable box refuses, never widens**: `CheckFilters.refused`
makes `buildWhere` match nothing (`id IN ()`), so the list shows no rows, with a red chip naming
the bad filter (since the table kit; it used to leave the boxes in place); the export answers 400, print shows the refusal, and EXPORT
EXCEL / PRINT are drawn disabled. SIGN ALL honours the column filters — the server re-parses them
from the confirm form's hidden `f.*` fields, and the button is offered only when `signAllOffered`
(`lib/dashboard-view.ts`) says so; RELEASE ALL refuses any column filter. **Columns:** `cols=` on
EXPORT EXCEL reorders the file's columns and never drops one. The preference is the table kit's
`check-monitoring.table.checks.v1` (an ordered list of visible columns), migrated once from
`check-monitoring.columns.v3` (it was `check-monitoring.columns.v2` before the kit); a column forced visible because a filter is set on it is shown but never
persisted. Print keeps its fixed columns.

**Every table is on the table kit** (2026-10-13, spec `2026-10-13-table-kit-design.md`, the Supplier
Portal's header menu). Click a header: Sort Ascending / Descending, Clear Filter, the filter (date
and amount: Equals … Is Between, Today, This Month; enum: a dropdown, or ticked boxes for a `multi` column — the main list's STATUS since 2026-10-15,
needle `=A,B`, URL `f.status=SIGNED,RELEASED`, one bad value refuses the box, one status is
`CheckFilters.status` and several `statusIn`; text: contains). Chips above
the table; ⚙ CUSTOMIZE COLUMNS opens Column Configuration; drag a header edge to resize. Layout is
per browser under `check-monitoring.table.<id>.v1`. Two modes: `KitTable` filters the rows the page
drew (a capped page says "N OF THE M ROWS SHOWN"); the main list and Audit are URL mode — the menu
writes the parameters they already parse (`lib/table-kit/url-binding.ts`), so on the main list
`lib/column-filters.ts` still refuses, and "Does Not Equal" / strict amount bounds are not offered
there. The filter-box row and COLUMNS chooser are gone; their values ride as hidden inputs on the
bar's form. Audit does not sort (its keyset is newest first). Left alone: print (including the printed transmittal sheet), the forecast
matrix, the planned-outflow list.

**`/signup` is public and creates INACTIVE accounts only** (2026-10-09, spec
`2026-10-09-self-registration-design.md`, §11 for what changed in review). A registration sets
`User.pendingSince`; PENDING is `!active && pendingSince !== null` (`isPending`, `lib/admin/users.ts`,
the one definition) and is shown on `/admin/users` under PENDING APPROVAL, where APPROVE picks the role
and REJECT leaves it deactivated. **Registering with an INACTIVE account's address re-opens it** —
user ruling 2026-10-09, so the three deactivated accounts Finance asked to delete could register again
— but **nothing on the row changes until approval**: the typed name and password wait in
`pendingName` / `pendingPasswordHash`, because `name` is read live wherever a check says who released
it and an anonymous `/signup` submission must not rewrite that. APPROVE copies them in; REJECT discards
them, so REACTIVATE after a reject restores the genuine account; SET PASSWORD discards a held hash. An
ACTIVE address is refused. REACTIVATE refuses a pending account (approve instead). Every
read-then-write is a conditional `updateMany` on the state it read (`REREGISTERED` / `NOT_PENDING` /
`CHANGED`), and the page passes the `pendingSince` it displayed. Throttle: `signup.ipPerHour`
(default 5) over `RegistrationAttempt` in Postgres (`lib/registration-throttle.ts`) — an advisory
xact lock per address, insert then count, refused when the count including this row exceeds the
allowance, and **refused, not let through, when the attempt cannot be recorded**. Length caps and a
minimal email shape check sit on the public action. The sign-in error stays generic, and `/login` now
redirects a refused sign-in to `?error=CredentialsSignin` instead of letting next-auth's throw become a
500 (pre-existing). No mail path, no domain restriction, no delete (rule 6). `node
scripts/dev-test-db.mjs` runs the dev server on the TEST database for a browser check.

**READY FOR RELEASE from an uploaded list** (`/admin/import`, top section, user request 2026-10-29;
`lib/admin/ready-upload.ts`, `uploadReadyListAction`, `components/ReadyListUploadForm.tsx`). A Finance
Admin uploads an .xlsx whose rows name the AP BILL a cheque pays, and the CHECK NUMBER when the
list has one (headers in the first five rows; every sheet carrying an AP BILL column is read, any
other skipped and named); one pickup date for the batch. **A sheet with both columns is keyed on
the number**: it finds exactly one live cheque (a cancelled/voided twin is ignored; two live ones
refuse), and the bill must be one that cheque carries (`apvNumbers` ∪ `CheckBill`) — otherwise the
row is left alone and the report says where that bill is held. **A sheet with only the bill column
is keyed on the bill** (`UploadRow.keyedBy`, same day: the file Finance uploads is Acumatica's AP
bill export — `Date`, `Post Period`, `Reference Nbr.`, `Vendor Ref`, `Vendor Name`, `Balance
Amount`, no check number at all): the bill finds exactly one live cheque carrying it, none or two
leave the row alone. Nothing is written without a preview; the confirmation re-sends and re-plans
the same file. Every write goes through the domain: `markSigned` first for a SIGNATURE_PENDING
cheque, then `markReadyForRelease` — so `readyAt`/`readyById`/pickup date are set, a
MARK_AVAILABLE event is queued and kicked after the response, and the `ready_for_release` (and
`marked_signed`) audit rows carry a `source` (file, sheet, row, bill; `ActionSource` in
`lib/domain/actions.ts`). RELEASED, READY/SCHEDULED, GENERATED, non-cheques and Acumatica-Voided
are reported, never touched; **nothing is ever demoted by a list**. A cheque whose status moved
between preview and confirm is refused by name. The apply loop stops at 30 s and counts what it
did not reach; the same file uploaded again finishes it (readied rows read ALREADY READY). The
portal kick after the response has 25 s (`READY_UPLOAD_KICK_MS`), not the usual 8 — the first real
upload (2026-10-29, 165 checks marked in 3 s) sent 75 MARK_AVAILABLE events in 8 s and left 90 for
the cron — and `/admin/import` declares `maxDuration = 60` so both budgets fit. This is
the routine path; `release-list.ts` and `mark-ready-from-release-list.ts` remain the one-off
catch-ups that set status directly with no approver and no portal event.
**First real upload, 2026-10-29 18:36 Manila:** `FOR RELEASE 10.30.2026 - fixed.xlsx`, sheets LIST
(179 rows) and CHANGES (90 rows, every bill also on LIST — 0 checks from CHANGES alone): 165
checks READY (6 signed first), 14 LIST rows left alone. Summary of the 165 written to
`snapshots/READY FROM LIST 10.30.2026 - summary.xlsx`. One of the 14 was `1791363258`
(CV-A1011925, GDSM MARKETING, AP-A1033419): CANCELLED here only because the register's CANCELLED
sheet (row 751) said so on 2026-09-04, Closed in Acumatica, and the 2026-10-29 `apv_detached_on_cancel`
run had stripped its bill, so the bill named no check. **Restored to SIGNED on the user's instruction
2026-10-30** (`scripts/reinstate-register-cancelled.ts --apply --check 1791363258`,
`lib/admin/register-cancelled.ts`, one `cancel_reverted_register_only` row, bill re-attached, snapshot
`snapshots/reinstate-register-cancelled-2026-10-29T23-06-54-373Z.json`) — status only; the upload
readies it. **Note the contradiction and keep it visible:** Finance's own `CANCELLED VS ACUMATICA
2026-10-06..xlsx` ruled this check NEW STATUS = CANCELLED (to be voided in Acumatica); it was never
voided, went Closed on 2026-10-12, and the 10.30 list names its bill. The user's 2026-10-30 word
overrides the 10-06 file for this one check. **The other 17 candidates the script lists all carry a
ruling to stay CANCELLED and were not touched:** 8 STALED by Finance 2026-10-07 (`isStale`), 4 the
user reverted on 2026-10-07 (`1791361448`, `179174`, `179175`, `6000308871`), and 5 ruled CANCELLED in
the 10-06 file (`1791362864`, `1791363469`, `6000318754`, `6000330347`, `1791363720` — payroll,
INTERNAL) that have not been voided in Acumatica either. The script's dry run shows the ruling per
check; `--check` one of them only on a new Finance ruling, never `--all` on a hunch.

**A deploy from a branch behind master REGRESSES production** (measured 2026-11-03). `npx vercel
--prod` builds the working tree you run it from, not master. `feature/check-inventory` was cut from a
9 October base; deployed at 07:01 Manila it put a build 127 commits behind master on
`checkmonitoring.rclcompanies.com` for two hours: the dashboard threw `Value 'OTHERS' not found in
enum 'ReceiptType'` (production rows already held receipt types that older build did not know), the
aging screen, notifications and the table kit were gone, and sign-in showed "Application error" for a
mistyped password (master had fixed that on 9 October). Before any deploy: `git log --oneline
feature/<branch>..master | wc -l` must be 0 — merge master in first — and the migrations production
has applied (`_prisma_migrations`) must all exist in `prisma/migrations` (`prisma migrate status`
says "up to date" even when production has MORE). `npx vercel ls --environment production` lists what
is live; `npx vercel promote <deployment-url> --yes` puts a known-good one back without a build.

**`/welcome` is the public front door, and it is public by name** (2026-09-27, spec
`2026-09-27-landing-login-and-theme-design.md`). The landing page and `/login` both render
`components/MoneyMachines.tsx` — a cash register and a check register, inline SVG moved by the
`mm-*` keyframes in `app/globals.css`, running for as long as nobody is signed in; either page
redirects a signed-in visitor to `/`. `/welcome` is listed in `isPublicPath` (exact match, pinned),
the middleware sends an anonymous bare `/` there and every other guarded path to `/login` as
before, and sign-out lands on `/welcome`. `requireUser()` still redirects to `/login`. The page
reads no data and must never show a figure: it is the one page a stranger can load.

**Availability changes are approved by one person (2026-11-05, spec
`2026-11-05-availability-approval-design.md`; user ruling: *"all should be approved by Paolo Parcon …
only for the checks available for release. I want to have control in this because these are also
communicated in the supplier"*).** The two changes the supplier is told about — MARK READY FOR RELEASE
(SIGNED → READY_FOR_RELEASE) and REVERT TO SIGNED (READY/SCHEDULED → SIGNED) — go through
`applyOrRequest` (`lib/domain/availability-approval.ts`) from the check page, the list's bulk bar, AGING
and the `/admin/import` READY upload. The approver is the setting `approval.availabilityApprover`
(`/admin/settings`, group APPROVAL, a dropdown of active users; kind `user`, the twelfth knob; NOBODY by
default, which is **no approval step** — set it after the deploy). With a person set, that person's own
actions apply at once and everyone else's become an `AvailabilityRequest` (one PENDING per check,
`pendingKey` unique with `checkId`): **the check does not move, no pickup date or `readyAt` is written and
the portal hears nothing until approval.** Requesting runs the same refusals as applying (missing fields,
reason, from-status), so the requester hears them at once. `approveAvailabilityRequest` applies the
domain action AS THE APPROVER (`readyById`, the `ready_for_release` / `reverted_availability` audit
actor) with `details.approval` naming the request and requester; a check that moved since is refused
`REQUEST_STALE` and must be rejected by hand; REJECT needs a note. Only the approver decides, not another
admin — except that while NOBODY is set a FINANCE_ADMIN may close leftovers. `/approvals` (every user;
APPROVE/REJECT for the approver, per row and over a selection), an APPROVALS header link with the pending
count, a WAITING FOR APPROVAL panel on the check page, REQUEST… button labels for non-approvers, a
dashboard TOTALS line, `requested` on the upload report, `APPROVAL_REQUESTED` (to the approver) and
`APPROVAL_DECIDED` (to the requester) notifications — a new `USER` audience with `userId` in `notify`.
Audit: `availability_requested` / `availability_approved` / `availability_rejected`. Migration
`20261105000000_availability_request` must reach production BEFORE the deploy (the header counts the table
on every page). **Closed with it:** `markSigned` refuses anything but SIGNATURE_PENDING/GENERATED
(`NOT_PENDING_SIGNATURE`) — on 2026-11-04 36 READY checks were taken off the release list with MARK
SIGNED on the list, pickup date kept, portal told nothing, suppliers reminded seven more times — and
`revertAvailability` refuses anything but READY/SCHEDULED (`NOT_AVAILABLE`; RELEASED → SIGNED is
`reverseRelease`'s). Not gated: MARK RELEASED / RELEASE ALL, REVERSE RELEASE, the one-off catch-up
scripts. **Still open from the same day:** the 36 SIGNED-by-mistake checks are to be re-readied by the
user (an upload-shaped list was provided); the portal's deployed code ignores a REVERT on a RELEASED bill,
so the four RELEASED → SIGNED reversals of 2026-11-04 (`6000353231`, `6000353362`, `6000353678`,
`6000354854`) are still paid there until the portal fix in `~/Downloads/Supplier-Database-claude-reissue-revives-cancelled-row`
is carried into its repo and deployed; this app records the portal's `noop` answer as a clean SYNCED.

**A cancelled or voided check is detached from its AP bills, and the portal is not told** (user
ruling 2026-10-29: *"Once the check is cancelled, it should not be connected to the AP it was applied
to"*; spec `2026-10-29-cancelled-check-detaches-from-ap-design.md`). The portal keeps one release row
per BILL, keyed by APV; this app keeps events per check. A void and re-issue is two checks on one bill,
and the voided check's CANCELLED event cancelled the bill's row in the portal, so the replacement's
RELEASED was refused — `6000354974`..`77` on `AP-ST039900`/`07`/`10`/`12`, released 26 Oct, four
RELEASED events parked *"cancelled in the portal; a super must resolve"*. **That message names no
screen: the portal has no manual restore of a cancelled row, and its Excel re-issue path is retired.
The resolution is in the portal's code** (`prop-db/Supplier-Database`, `src/integrations/check-monitoring.js`,
branch `claude/reissue-revives-cancelled-row`, 2026-10-29): a RELEASED arriving on a row the portal
cancelled on Check Monitoring's own CANCELLED (`cancel_requested_at` null) under a DIFFERENT check
number is applied as the re-issue it is; the same number, or a portal user's cancellation, stays
refused. **Deployed 2026-10-29 ~17:20 Manila by the user (`npx vercel --prod` from a ZIP of the branch,
Vercel project `supplier-portal`); RETRY then delivered the four RELEASED events and their receipts,
0 parked after. The branch is merged into the portal's `main` (fast-forward) and this one into
`master`, because both systems deploy the LOCAL tree and a later deploy from main would otherwise drop
the fix. Check Monitoring was deployed from `~/Projects/checkmonitoring` the same day (Ready in 53 s);
Vercel reports that project as "linked by git", so a push to `master` may deploy it as well.** **It also covers the 23 voided checks detached today: their CANCELLED events were
delivered weeks ago, so their replacements will meet the same refusal when released.** On 2026-10-29
the user reversed and re-released the four (receipts removed and re-typed), which changed nothing at
the portal — do not do that again; the parked rows wait for the portal deploy. Now `voidCheck` / `cancelCheck` call
`detachFromBills` (`lib/domain/actions.ts`): `apvNumbers` emptied, `CheckBill` rows deleted, NO
portal event, `portalSyncStatus = NOT_APPLICABLE`; the `cancelled` / `voided` row carries
`apvNumbersDetached`, `billsDetached` (whole rows) and, for a routed check, `portalNotified: false,
portalSkipReason: DETACHED_SKIP_REASON`, and its remark names the APVs. Nothing re-links a dead check:
the BILLS read skips a CANCELLED/VOIDED check (counted `cancelledHere`, named in the run message —
Acumatica still lists a voided payment's applications), `upsertCheck` merges no voucher onto one, and
`matchBills` (approval workbook) never matches one — so a voucher naming a voided check and its live
re-issue resolves to the re-issue. `restoreCancelled` re-attaches the detached vouchers (not the bills)
unless a live/RELEASED check of the company has taken one since. **Consequence, accepted with the
ruling:** the portal hears of no cancellation at all, re-issue or not; a bill whose check was
cancelled with no replacement keeps whatever state the portal had until someone there changes it.
`scripts/detach-cancelled-apvs.ts [--apply]` (`lib/admin/detach-cancelled-apvs.ts`) detaches the
checks cancelled or voided before the rule and closes their open CANCELLED events unsent
(`unmatchable: …`, counted on `/admin/portal`), snapshot first, one `apv_detached_on_cancel` row each —
**run 2026-10-29 by the user, from a Mac, in two passes** (the first was interrupted after a few
checks because the script prints nothing while it works; the second found 23 left, all VOIDED, and
detached 23 of 23, 0 open CANCELLED events, 0 still connected; snapshots
`snapshots/detach-cancelled-apvs-2026-10-29T08-06-47-676Z.json` and `…T08-14-04-455Z.json`, on the
user's machine). `queueCancelledForStale` (`--queue-cancelled`) is superseded and
must not be run again. **The user's scripts now run from a Mac** (`~/Projects/checkmonitoring`,
plain `npx`); the `npx.cmd` note above is for the Windows machine. The Neon address has two
databases on one project: `check_monitoring` is NOT production and lacks recent columns —
`check_monitoring_prod` is. The 2026-10-01 guard below is subsumed: a cancelled check never has an APV now.

**Every check, cancelled and voided included, is mirrored into the portal's own check list**
(user ruling 2026-11-03: *"make sure all the checks including cancelled, void from the system are
in the portal"*, answered "Full check list"; spec `2026-11-03-check-list-in-portal-design.md`,
identical in both repos). The per-bill release rows cannot show a void (a CANCELLED hits the
replacement's row — the 2026-10-29 rule), so the portal has a second table, `cm_check`, keyed by
this system's check id, fed by `PUT /api/integrations/check-monitoring/checks` (same bearer) and
read on its **All Checks** page (admin tiers only; rule 2 holds — an INTERNAL check is in it,
flagged, and no payee can read it). The feed is `lib/integrations/portal/check-feed.ts` (pure row;
detached APVs come from the cancel/void audit rows, POs from `displayPoNumbers`) and
`lib/sync/portal-checks.ts`: pages `Check` by `(updatedAt, id)` from a `SyncRun.mode =
'PORTAL_CHECKS'` watermark (10-minute overlap, 500 a batch, the watermark held at the last batch
sent on any error, a full push resumable from an epoch watermark). **Every portal kick pushes the
list after the outbox** (`kickPortalDelivery`; skipped under 2 s of budget), so the cron and every
action keep it current; `/admin/portal` shows CHECK LIST (last push, checks behind, total) and
SEND EVERY CHECK (FINANCE_ADMIN, full, 50 s); `scripts/push-checks-to-portal.ts [--full] [--dry-run]`
is the terminal form. The portal skips a row not newer than the one it holds, so a retry never rolls
a check back; nothing is deleted there; nothing comes back (rule 12). **Go-live order: portal
migration 096 and deploy first, then this deploy, then SEND EVERY CHECK once.** The 11 RELEASED
checks the portal was never told about (`1791363573 1791379615 1791379616 1791405441 1791405471
6000338817 6000349425 6000353624 6000353695 6000353743 6000353877`) arrive with the release date
this system holds — none or a register day — and still need Finance's real day.

**A void or cancel of a check with no APV queues nothing for the portal** (2026-10-01, spec
`2026-10-01-cheque-numbering-and-cancel-guard-design.md`; subsumed by the 2026-10-29 rule above). The portal matches on APV and the client
refuses an event with none, so such an event parked on its first attempt and RETRY parked it again —
which is how `6000354350` and `1791259553` reached `/admin/portal`. `voidCheck` / `cancelCheck` now
ask `portalApvs` (`lib/integrations/portal/apvs.ts`, the same rule the client uses) first; a routed
check with none gets `portalSyncStatus = NOT_APPLICABLE` and `portalNotified: false` on its audit
row. Only CANCELLED is guarded. `scripts/close-unmatchable-cancelled.ts` closes the ones already
parked (`unmatchable: no APV numbers`, counted on `/admin/portal`). **Run once, 2026-10-01, by the
user with `--apply`: closed 2 of 2 (`6000354350`, `1791259553`), 0 left, snapshot
`snapshots/close-unmatchable-cancelled-2026-10-01T10-08-40-568Z.json`.** It ran just BEFORE that
day's deploy rather than after a cron delivery, so a no-APV CANCELLED still PENDING then could park
once more on the next run; if `/admin/portal` shows one, run the script again.

**AGING (`/aging`) picks SIGNED checks for release in the Supplier Portal's buckets** (2026-10-15,
spec `2026-10-15-aging-module-design.md`). CURRENT / 1–30 / 31–60 / 61–90 / OVER 90 / NO DUE DATE,
on days past the EARLIEST due date of the bills a check pays (`lib/aging/buckets.ts`; COD, PDC,
dated-check and 100PBD terms never age, as in the portal). The due date and terms come from
`AP-Bills and Adjustments` into `AcumaticaBillTerms` (written by the BILL_REFS read for every
in-scope bill, blank Vendor Ref included, never deleted; `CheckBill.dueDate` only where Acumatica
states none). MARK READY FOR RELEASE calls `bulkReadyForReleaseAction` unchanged — no new write
path — and submits only `effectiveSelection`: ticked checks still on the page, with a SELECTED view
listing every one of them, so nothing hidden is readied. A card counts every check in its bucket;
its amount is PHP only, and the page says how many it leaves out. The totals do not match the
portal's aging and are not meant to: the portal ages open bill balances, this ages SIGNED check
amounts.
**Bucket by column (2026-10-16, user request).** The table shows one amount column per bucket
(`BUCKET_COLUMN_KEYS` in `lib/aging-picker.ts`) — a check's amount sits under its own bucket only —
with a TOTAL (PHP) row over every row the view matches; BUCKET and AMOUNT are hidden by default
under CUSTOMIZE COLUMNS. The layout key is `aging.by-bucket` (renamed so a layout stored for the
old single-column table does not keep it). The export matches: SUMMARY, then `ALL CHECKS`, then one
sheet per non-empty bucket, each built by one `addCheckSheet` with the same columns (CURRENCY, then
the six buckets) and a bold TOTAL (PHP) row; an unreadable amount is blank, never 0.
**Live since 2026-10-16.** Migration `20261015000100_acumatica_bill_terms` reached production
before the deploy. **First fill run by the user that day, `--bill-refs --full` from a master
worktree: GOLIVE 41,825 fetched, 37,822 terms rows written; MANUFACTURING 244 fetched, 181 written;
0 errors**, snapshots `snapshots/bill-refs-<TENANT>-2026-10-16T01-1*.json`. The 12:00 and 18:00
BILL_REFS runs keep it current. Since 2026-10-16 every BILL_REFS run that reaches the write phase
records `due dates: N bills written` as the start of its `SyncRun.message` (problems follow after
` | `), so `/admin/sync` shows whether due dates are being kept current; no column was added (the
BILLS read's `runMessage` is the precedent). A run whose fetch fails has no such prefix. **Running any `scripts/*.ts` from a
deploy worktree needs `npx prisma generate` there first** — the junctioned client is generated from
whichever checkout last ran it, and a new model reads as `undefined` ("Cannot read properties of
undefined (reading 'findMany')"); the first fill hit exactly that, before any write.

**NUMBERING (`/numbering`) checks check consecutives per check book.** Every check of every
status — VOIDED, CANCELLED and no-amount included — in BigInt order; each unused number between a
book's first and last is one MISSING line, however large (user ruling 2026-10-01: "every number
counts", not a booklet heuristic). The check book is the series key — Acumatica's CashAccount value
(spec §D, 2026-10-02); checks with no book are a stated count. A series holds every company's
checks in that book; the company filter selects the books a company uses and shows them whole. MISSING is bounded by the sync's scope (2026 onward, CHK or CASH). A number Acumatica
re-used with a trailing dot — a second payment document on the same check number, which Acumatica
will not accept twice on one cash account — sits on `/admin/staged` as NO_CHECK_NUMBER and is shown
as a **STAGED** line, never MISSING (`stagedSeriesNumber`, spec §C, 2026-10-02). Measured that day:
169 staged payments end in dots, 66 of them on a number a different payment already holds here under
the same company — **do not strip the dot at import**; it would collapse two payments onto one
`(companyId, checkNumber)` check. A number whose shape (digits without leading zeros, first two
digits) differs from its book's usual one is OUT OF PATTERN — listed separately and left out of the
gap count — once the book has 20+ numeric checks (spec §F, 2026-10-05; measured ~100 such Acumatica
checks, e.g. `60003162116`, `17913405552`, `1791…` numbers under BPI books). **Known limit:** the
shape includes the first two digits, so a book that rolls over a lead or a digit count (`179999` →
`180000`, `999999` → `1000000`) would put the new booklet in OUT OF PATTERN until it outnumbers the
old one; if a book starts showing a whole run there, that is the cause. **User ruling 2026-10-05:
"Follow acumatica."** NUMBERING shows Acumatica's numbers as they are — no further heuristics
(range outliers, smaller pattern minimum). A typo that keeps the right shape (live examples that day:
`6000859726` in `BPI-A-5713`, `1793161601` in `MBT-A-4155`, `1790405938` in `MBT-A-9048`) and the
OUT OF PATTERN lists are corrected IN ACUMATICA; the next sync renumbers the check here by its
payment reference (`renumbered_by_acumatica`) and the series corrects itself. Memo-numbered checks (`PCF26-00001`) still hide behind MISSING;
the page says so. Since 2026-10-05 (spec §G) only Acumatica checks are shown (register-only checks are a stated count), `backfill-check-books.ts --apply` moves a check whose book differs from Acumatica's onto Acumatica's (and clears it when Acumatica names a non-book account) — **run 2026-10-06 by the user on both tenants: 61 `check_book_realigned_to_acumatica` rows (56 moved, 5 cleared), snapshot `snapshots/check-books-GOLIVE-2026-10-05T23-03-14-358Z.json`; after it 0 to fill, realign or clear on either tenant — every Acumatica check's book is Acumatica's. 11,934 Acumatica checks, 11,043 with a book; 1,142 register-only, not shown** — and the Excel has a TO FIX IN ACUMATICA sheet — the OUT OF PATTERN checks and each book's stray ends (> 10,000 from the next number) with their CV, newest check date first (undated last; user request 2026-10-06). `next build` failed with *Cannot mix BigInt
and other types* (Next's file tracer) on `1n`-style literal arithmetic in `lib/numbering/series.ts`;
it uses `BigInt(0)` / `BigInt(1)` constants instead — keep it that way.

**NUMBERING is also the CHECK INVENTORY (2026-11-03, spec §H).** On a book's page EVERY line — a
held check of any status and every MISSING number — has a tick box and a remarks field
(`components/InventoryNoteCell.tsx`), so the physical count is recorded here and not in a
spreadsheet. The series table is a `KitTable` (`numbering-inventory`, spec §H8): held, staged and
MISSING-number lines are data rows that survive the kit's filter and sort (STATUS contains MISSING
lists the gaps; INVENTORY contains UNTICKED lists what is left to count), a long run is a band
(`MissingRunBand`) that hides while filtered or sorted, and the table says so. **Nothing is saved as it changes**: each change is a draft in
`components/InventoryForm.tsx`, the sticky bar counts UNSAVED CHANGES, and SAVE INVENTORY
(`saveInventoryAction` → `recordInventoryNote` in `lib/numbering/inventory-notes.ts`, every Finance
user, one row and one audit entry per change, answered per row, 25 s budget then "press again")
records them (user ruling, same day: "there should be save button"). A run of more than
`INVENTORY_LIST_MAX` (100) numbers is one line with one tick and remark for the whole run, keyed to
its first number with `runTo` stored, and **opens on a click into one row per number, 200 at a time**
(`components/MissingRunRows.tsx`); the line says so when the run has since changed shape. **A note is
on one number OR on a run — the key is (book, number, runTo), `runTo = ''` for a single number**
(migration `20261103000100`), so the run's tick and its first number's tick are two rows. Measured
2026-11-03: 687 runs in 9 books, 579 listed number by number at 100 (5,014 lines, at most 1,915 on
BPI-S-4636). Notes live in `CheckInventoryNote` (book + canonical number, never deleted), each write
one `inventory_note_recorded` audit row — with the check's `checkId` on a held number, NONE on a
MISSING one (the audit screen's check-number filter finds the former only; filter by action for the
rest). A held check's note is never written onto the check; the first pass refused held numbers and
the user reversed that the same day ("why the released and other checks doesnt have check box?").
`buildSeries` and every count are unchanged; `NumberingAccount.lines` (`lib/numbering/inventory.ts`,
pure) is the series as the inventory shows it, TICKED counts held and missing ticks alike, and the
Excel book sheets write one row per listed MISSING number plus TICKED, REMARKS, RECORDED BY,
RECORDED AT. **Migrations `20261103000000_check_inventory_note` and `20261103000100` must reach
production BEFORE the deploy that carries them** — the page reads the table on every request (both
applied 2026-11-03).
**A check with no check book is shown where its number falls (2026-11-03, spec §I).** Finance's
count found `1791405927` (CV-A1013436, A1+, SIGNED since 6 Oct, in the portal feed) as a MISSING line
reading "NO CHECK IN THIS SYSTEM": Acumatica posted it on the cash account `PAYROLL`, which is a cash
account here and not a check book, so it had no `checkBookId` and the series read only checks with a
book. **1,027 Acumatica checks carry no book, 1,026 on PAYROLL** (915 RELEASED, 74 SIGNED, 18 pending,
20 VOIDED), every one a false MISSING somewhere. `buildSeries(cheques, staged, unbooked)` now places a
no-book check whose number matches the book's pattern and lies STRICTLY INSIDE the book's own sequence
as a CHECK entry flagged `noBook` — a lookup by number, not a guess: it never bounds the series, never
votes on the pattern, is not `held`/`voided`/`cancelled`, is a DUPLICATE when the book's own check
shares its number, and is counted in `summary.noBook` (NO CHECK BOOK column on the summary and the
SUMMARY sheet). Where several books' sequences span it, it is in each (the page says so); outside
every book it is still "not in any series". The line is blue-tinted, tagged `NO CHECK BOOK · PAYROLL`
(`SeriesCheque.cashAccount`), inventoried like any number (its audit row carries the check's id —
`recordInventoryNote` looks among no-book Acumatica checks too), and the file's NOTE names the cash
account. Finance posts through PAYROLL on purpose, so this is NOT on TO FIX IN ACUMATICA. Verified
2026-11-03 against the TEST database: the line, the tag, a saved tick and remark with the check's
`checkId`, the summary column and line, and the export answering 200.
**Every non-zero count on the NUMBERING summary opens the book pre-filtered (2026-11-03, spec §K).**
`?show=voided|cancelled|staged|ticked|noBook` (`parseShow` / `showFilters`, `lib/numbering-view.ts`)
rides into `KitTable`'s `initialFilters`, so it is a kit filter — chip, CLEAR FILTERS, header menus —
not a server one; MISSING opens `?missing=1`, NOT NUMERIC and OUT OF PATTERN anchor to their tables.
**`MBT-S-9048` is an alias of `MBT-A-9048`** (`lib/check-book-alias.ts`, applied in `upsertCheck`'s
book lookup and in `planCheckBookBackfill`, so the sync keeps new payments on MBT-A-9048):
`scripts/merge-check-book.ts MBT-S-9048 MBT-A-9048 [--apply]` moves its checks once (snapshot first,
one `check_book_merged` row each, status untouched, the emptied book deleted with one
`check_book_retired` row). Only a pair in `CHECK_BOOK_ALIASES` can be merged. **Run 2026-11-03 17:59
Manila by Claude on the user's instruction: 13 of 13 moved (7 RELEASED, 4 SIGNED, 2 pending; A1+, A1PP,
STK, HAMFI), 0 notes, MBT-S-9048 deleted; after it MBT-A-9048 holds 1,272 checks; snapshot
`snapshots/merge-check-book-MBT-S-9048-2026-11-03T09-59-19-492Z.json`.** `17913404695` (11 digits) now
sits in MBT-A-9048's OUT OF PATTERN list, as it did in the alias book's.

**NUMBERING's heading is frozen, INVENTORY filters on TICKED / UNTICKED, and SUMMARY has a TOTAL row (2026-11-03, spec §J, user request).** `KitTable` takes `stickyHead` — the frame becomes `max-h-[80vh] overflow-auto` (`STICKY_FRAME`) and the head `sticky top-0` (`STICKY_HEAD`), because a sticky element pins to its nearest SCROLLING ancestor; a side-scroll-only frame gives it nothing to stick to; the footer pins to the bottom the same way. Only the two NUMBERING tables opt in. INVENTORY is an enum column (TICKED / UNTICKED, exact match) — as a text column "contains TICKED" also matched UNTICKED — and the remark text is its own hidden REMARKS (SEARCH) column under CUSTOMIZE COLUMNS. `numberingTotals` (`lib/numbering-view.ts`, pure, BigInt for MISSING and TICKED) sums every SUMMARY count over the books shown; the page says `TOTAL CHECKS: N HELD IN M CHECK BOOKS`, the table has it as a footer, and the SUMMARY sheet a bold TOTAL row.

**A time shown to Finance is formatted in Manila, by name** (`formatManila`, `lib/manila-format.ts`, 2026-11-03). Every page renders on the server and Vercel's clock is UTC: /admin/portal said "Last push Nov 3, 9:23 AM" for the 5:23 PM push that completed the check list, and the sync, users, print, check, receipt, staged, voucher and import-preview pages, the audit trail and the dashboard workbook's stamp were the same 8 hours behind. A day stored at Manila midnight (`manilaDayStart`) is the evening before in UTC, so an unzoned date-only format is a day early too. Every `toLocaleString('en-PH', …)` in server code now goes through `formatManila` or names `timeZone: 'Asia/Manila'`; a new formatter without the zone repeats the defect, and `tests/manila-format.test.ts` pins the rule. Client components (`CheckTable`) format in the browser, which is already Manila.

**A `|` inside `-t` breaks `npx.cmd vitest` under Git Bash.** `npx.cmd vitest run file -t "a|b"`
mis-tokenises the pipe; `node node_modules/vitest/vitest.mjs run file -t "a|b"` is the same
runner without the `.cmd` shim and works.

**`npx tsc --noEmit` is not optional.** Vitest transpiles with esbuild, which erases types — this
project has repeatedly had a fully green suite over unsound types. Overrides spread from a
union-typed `it.each` tuple also escape excess-property checking; that hid a real bug here.

**`middleware.ts` does not run LOCALLY — and DOES run on Vercel.** A clean local `next build` leaves
the middleware manifest empty (`export const runtime = 'nodejs'`, Next 15.5.25), which is where the
earlier claim that it never runs came from. **Measured 2026-09-11 against production:** an
unauthenticated GET of `/api/cron/sync` — a route with no session guard of its own — answered
**307 to `/login` with NextAuth's `__Host-authjs.csrf-token` cookie set**, and so did the same
request carrying a bearer. Only the `auth()` middleware wrapper does that. Vercel's build registers
the file; the local one does not. Two consequences, both binding:

- The page-level `requireUser()` / `requireAdmin()` guards remain the **primary** control and must
  stay — a local build that drops the middleware must leave the app protected, and a bad matcher
  edit must not be able to expose a page. **Every request-time control still lives in the request
  path.**
- **A route that a machine calls with a bearer and no session must be listed in `isPublicPath`
  (`lib/public-paths.ts`, tested) and must guard itself.** The scheduled sync was deployed without
  that and every evening's run would have been a 307 to a login page — reported as success, reading
  nothing. `tests/public-paths.test.ts` pins `/api/cron/` open and everything else closed.

**One agent at a time against the test database.** All test files share one Neon database and
`resetDb()` truncates it. Concurrent runs produce `40P01` deadlocks and spurious FK failures, and
they destroy an in-flight import. `fileParallelism: false` prevents this within a run and cannot
prevent it across processes.

**Prisma’s interactive-transaction defaults are far too tight for an import.** 5s to run, 2s to
acquire a connection. One row of `upsertCheck` is four round trips to ap-southeast-1, so across
9,515 rows one row eventually runs long and kills the WHOLE run — surfacing as *"Transaction not
found. Transaction ID is invalid, refers to an old closed transaction"*, which reads as a connection
fault and sends you to look at Neon rather than at the default. It killed the 9 September register
load after about 5,000 checks. `TX_OPTIONS` in `lib/import/upsert.ts` raises it to 30s. Any new
long-running write loop needs the same; the import is idempotent, so a killed run costs only time.

**The Neon connection string contains `&`, and `prisma migrate dev` refuses a non-interactive
shell.** `node scripts/migrate.mjs test` and `node scripts/migrate.mjs prod --confirm` apply the
migrations with the URL passed in `argv` and no shell, printing the host and database first. Every
migration must reach the TEST database before the suite is run, or every database test fails on a
missing column. Any other script that spawns the Prisma CLI must do the same: URL as an argv entry,
`shell: false`.

**`.env` values are quoted; Vercel stores quotes literally.** `dotenv` strips them locally, so
`DATABASE_URL="postgresql://…"` works on a laptop and fails on Vercel with *"the URL must start with
the protocol postgresql://"*. `scripts/set-vercel-env.mjs` strips them.

**Tests must never point at the application database.** `tests/helpers/test-db-url.ts` refuses to
run when `DATABASE_URL_TEST` is unset or equal to `DATABASE_URL`.

**A threshold is a setting, and the constant is only its default.** Since 2026-09-12 `STALE_AFTER_HOURS`,
`ABANDONED_AFTER_MINUTES`, `SYNC_IN_PROGRESS_MINUTES`, `MAX_BULK_SELECTION`, `EXPORT_ROW_LIMIT`,
`VOUCHER_SCREEN_ROW_LIMIT`, `autoSign.mondayEnabled` and the three login-throttle allowances are the DEFAULTS in
`lib/settings/registry.ts`; the value in force comes from `loadSettings` at request time, and every
function that uses one takes it as a parameter. A new call site that reads the constant directly
silently ignores the admin's setting. The category list is a setting too, and the domain refuses a
category not on it.

## Layout

| Path | Responsibility |
| --- | --- |
| `lib/domain/` | Pure rules. No database, network, filesystem, clock. `check-status.ts` (the ladder), `eligibility.ts` (the portal gate), `receipt.ts` (the OR/CR box — see rule 11). `actions.ts` is the deliberate exception — it takes `db` and is the only module that changes a status. |
| `lib/import/` | Workbook parsing → `parse.ts`, `field-sniffer.ts`, `company.ts`, `implied-status.ts`, `bills.ts`, and `upsert.ts` — the single write path where duplicate prevention lives. |
| `lib/integrations/acumatica/` | OData reader and mapper. |
| `lib/sync/run.ts` | Incremental sync, watermark with a 120-minute overlap. |
| `lib/sync/bills.ts` | The BILLS read: `AP-PAYMENTS-WITH-BILLS` applications unioned into `Check.apvNumbers` by `acumaticaPaymentId`; own watermark, `runScheduledBillsSync` for the cron. Since 2026-10-26 an incremental run also looks up each held check with no APV directly (`lookUpApvLess`), so a check created after the watermark passed its application is still linked. |
| `lib/integrations/acumatica/bills.ts` | The inquiry's per-tenant columns (`BILL_FEED_COLUMNS`), `ge` date filters, read-only. |
| `lib/sync/bill-refs.ts` | The BILL_REFS read: `AP-Bills and Adjustments` → `AcumaticaBill` (APV → real POs); own watermark, `runScheduledBillRefsSync` for the cron. |
| `lib/integrations/acumatica/bill-refs.ts` | `extractPoNumbers` (real PO shapes only), the inquiry's one column map (both tenants), `mapBillRef`. Pure. |
| `lib/sync/modes.ts` | `SyncRun` modes that are not the payment feed (`BILLS`, `BILL_REFS`); every payment-side reader excludes `NON_PAYMENT_MODES`. |
| `lib/integrations/portal/` | Supplier Portal client: `client.ts` builds the event body from the check at delivery time (asserts rule 2 again, pre-checks the portal's validation) and POSTs it with the bearer and a timeout; `from-env.ts` reads `PORTAL_BASE_URL` / `PORTAL_TOKEN`. Sends only (rule 12). |
| `lib/sync/portal-outbox.ts` | The outbox worker: latest event per check wins, stale kinds closed unsent (`kindMatchesStatus`), exclusive claims, backoff, `PARKED` for a human, a 401 stops the run. |
| `lib/sync/portal-kick.ts` | Best-effort delivery within a time budget, from an action (`afterResponse`), the cron and `/admin/portal`; never throws, `{ skipped }` when the env is unset. Since 2026-11-03 it also pushes the check list with the budget left (`checks` on the outcome). |
| `lib/integrations/portal/check-feed.ts` | The portal's check-list row (`buildPortalCheckRow`, `PORTAL_CHECK_BATCH`). Pure. |
| `lib/sync/portal-checks.ts` | The check-list push: `PORTAL_CHECKS` watermark over `Check.updatedAt`, 500 a batch, resumable full push; `pushChecksToPortal` never throws. |
| `lib/admin/portal-backlog.ts` | Backlog dry run for `scripts/portal-backlog.ts` (winners, superseded, `stale`) and `queueCancelledForStale` (`--queue-cancelled [--apply]`). |
| `lib/forecast/` | Cash outflow by check date: `buckets.ts` (the ageing buckets, pure), `query.ts` (the population — live, real, with an amount), `matrix.ts` (bucket × bank and bucket × stage, centavo-exact, pure). `/forecast` and `/api/export/forecast` sit on it. Since 2026-09-12 a check's typed `expectedOutflowDate` wins over its check date, and `PlannedOutflow` lines (`lib/planned-outflow/`, `/forecast/planned`) join the population as their own PLANNED column. |
| `lib/aging/` | AGING: `buckets.ts` (the portal's buckets, pure), `query.ts` (SIGNED, aged). `lib/aging-picker.ts` (strip, selection, pure). `/aging` and `/api/export/aging` sit on it (`lib/export/aging-workbook.ts`). |
| `lib/notifications/` | `messages.ts` (pure: what each notice says and to whom), `notify.ts` (the one writer; `safeNotify` for callers whose work has committed), `queries.ts` (bell count, page, mark read), `cron.ts`, `ready.ts`. `/notifications` and the header's NOTIFICATIONS link sit on it. |
| `lib/recon/` | Outstanding checks: `outstanding.ts` (the as-of rule, pure), `summary.ts` (per account, centavo-exact, pure), `query.ts` (the released population). `/recon` and `/api/export/recon` sit on it. |
| `lib/list-sort.ts` | The list's order: params, the `cm_sort` cookie, database and in-app keys. Pure. |
| `lib/column-filters.ts` | The filter row's `f.*` parameters: parsing, refusal, description. Pure. |
| `lib/normalised-row.ts` | The one shape both ingestion paths converge on. |
| `lib/settings/` | The eleven settings: `registry.ts` (pure — defaults from the constants, bounds, parsing), `read.ts` (one query per request, never cached), `actions.ts` (admin-only writes, audited). `/admin/settings`. |
| `docs/superpowers/specs/` | The approved design, and the Supplier Portal API evidence. |
| `docs/superpowers/plans/` | Plans 1–3. Plan 4 (reports, notifications) not yet written. |
| `docs/deployment.md` | Vercel procedure and blockers. |

## Data facts, measured — do not re-derive by assumption

The register (`CHECK MONITORING 9.1.2026.xlsx`) has 15 sheets and 12,227 data rows.

- **The payee is column E and the amount is column J on every sheet.** Read positionally. Guessing
  produced four classes of wrong payee (amounts, cash-account labels, point-person names) and, at
  one point, check numbers fabricated out of amounts.
- Import outcome: **9,461 rows import → 9,247 distinct checks**; 2,639 stage for no company, 61 for
  an ambiguous company, 66 for no check number. Every row is accounted for; nothing is dropped.
- **129 of the register-derived checks carry no amount** (production, re-measured 2026-09-06).
  The register's amount cell was blank or held the word "CANCELLED". They break down
  48 CANCELLED / 29 SIGNATURE_PENDING / 25 RELEASED / 23 SIGNED / 4 VOIDED, and 83 name a real
  payee. `Check.isIncomplete` flags them; `scripts/backfill-incomplete.ts` re-derives it.

  **MOST OF THEM ARE CANCELLED CHECKS, which is the client's own reading and it is right.** 80 of
  the 129 carry at least one cancellation signal: 59 sit on the register's CANCELLED sheet, 52 hold
  a CANCELLED or VOIDED status here, and **45 are Voided in Acumatica** — a voided payment keeps no
  amount, so a blank cell is what a cancellation is supposed to look like, not a defect.

  An earlier note here claimed Acumatica "has no record of any of them". **That was measured on
  2026-09-04, before the full sync, and it is no longer true**: 51 now match (45 Voided, 4 Closed,
  2 Balanced). Re-measure before repeating a count from this file.

  49 carry no cancellation signal. 15 of those were released with no amount recorded in either
  system — 13 on the BDO RELEASED sheet, 1 on MBTC P&P RELEASED, 1 Closed in Acumatica.

  **CLIENT RULING 2026-09-06: leave them alone.** "Those 15 are released in the excel records but
  no amount. Ignore them." The checks were handed over and the register says so; the amount was
  never written down and would have to come off a stub or a bank statement. Finance has decided
  that is not worth doing. **Do not raise this again, and do not write an amount for any of them** —
  a figure reconstructed from a bank statement and stored as if the register held it would be
  indistinguishable from a recorded one. They stay flagged `isIncomplete` and stay excluded from
  every total, which is the honest representation of a check whose value nobody knows.
  **They are excluded from every currency total rather than counted as zero** — SQL `SUM()` skips a
  null — and `tests/queries.test.ts` pins that. Do not "fix" it.
  **Since 2026-09-06 they are also out of the dashboard entirely**: "ignore them mean you have to
  remove them, dont consider them becuase they dont have amount". `CheckFilters.incomplete` is now a
  tri-state (`true` only them, `false` exclude, `undefined` no filter) and the dashboard, the export
  and the printed sheet all pass `false`. **Nothing was deleted** — rule 10 still stands — and the
  exclusion is stated on screen with the count and a link to `?incomplete=1`, which is the price of
  hiding them. `getSummary` narrows itself the same way `buildWhere` does, so a card's number is
  always the number of rows its table shows. There is no INCOMPLETE card any more.
- **The register's two reference columns hold the opposite of what their headers say.** Measured
  2026-09-07 over all fifteen sheets: the column headed `CHECKS APV` (column 4) holds **11,584 CV
  references and exactly one AP**, and the column headed `VOUCHER NUMBER` (column 8) holds **11,944
  AP references and no CV at all**. Do not read either positionally. `sniff` discriminates on the
  `AP-`/`CV-` prefix and always has, which is why `cvNumber` was right all along — the vouchers were
  parsed too and simply had nowhere to go, because `Check` had no column for them. It has one since
  2026-09-07 (`apvNumbers`), and `scripts/backfill-apv-numbers.ts` fills it for checks that
  pre-date it.

  11,904 parsed rows carry at least one voucher, covering **11,552 of the register's 11,779 distinct
  check numbers**. Those keyed rows carry **10,973 distinct vouchers**; twelve more sit on rows
  that cannot be keyed at all and are staged `NO_CHECK_NUMBER`, for 10,985 across the whole
  register. An import **unions** them onto the
  check rather than replacing: 360 check numbers sit on more than one row and 11 of those state a
  different voucher on each, so last-writer-wins loses one. An empty incoming array — every
  Acumatica row, since the payments inquiry publishes no bill references — never clears what the
  register recorded; the vouchers arrive by the separate BILLS read instead.

  Three cells in that column are AP vouchers `sniff` does not classify: `AP-A1-02663` and
  `AP-A1-030274` (a dash the `APV` pattern does not allow) and `AP-1PP-AP-000014` (a mis-key of
  `A1PP-AP-000014`). They fall to free text and are **left alone** — widening the pattern re-classifies
  12,000 rows to recover three, which is the wrong trade until somebody re-measures it.
- **The approval workbook's sheet names change with every export; its header does not.** 4 Sep:
  `LIST` + `PIVOT`. 7 Sep: `local supplier` (227 rows) + `BROKERAGE` (11) + `Sheet3`, the pivot.
  10 Sep: the same two data sheets + `PIVOT` again. `lib/import/bills.ts` therefore identifies a
  data sheet by the **24-column Acumatica header on row 1** (`isBillSheet`) and reads every sheet
  that carries it — a pivot's row 1 is empty. **Do not reintroduce a sheet-name check**: pointed at
  the 7 September file, the `LIST`-only parser read zero rows and reported success. Every sheet is
  reported by name, read or skipped, by the CLI and on `/admin/import`.
  `local supplier` ∩ `BROKERAGE` on 7 Sep is **two vouchers, both naming the same check**, so the
  `(checkId, apvNumber)` unique index folds them and there is nothing to arbitrate. A voucher naming
  *different* checks on two sheets would be a real conflict; it has not occurred.
  **`BROKERAGE` is a separate portal stream** (`POST /api/broker-checks/mark-available` vs
  `/api/checks/mark-available`). Nothing routes on it yet — Plan 3 — and the sheet is recorded on
  every bill's audit row and on every `StagedBill`. `CheckBill` has no `sourceSheet` column; adding
  one is the first thing Plan 3 will need.
- **The approval workbook's `check No.` column is not trustworthy.** Client instruction 2026-09-07:
  *"In CHECK MONITORING 9.4.2026 please use acumatica as reference for check numbers."* Row 81 of
  the `LIST` sheet holds the date `2026-08-13` where the check number belongs — that being check
  `6000353106`'s own date — and it is the only one of the 85 like that. Such a row is now resolved
  by its **voucher** against `Check.apvNumbers`, and only when that finds **exactly one** check;
  none or more than one and it is staged. A good check number that names no check here is *not*
  re-resolved by voucher — that would be overruling the workbook on evidence it did not offer.
  The 7 September workbook has **50 such rows**, not one — 47 on `local supplier`, 3 on `BROKERAGE`.
  Scale is not a reason to relax "exactly one match or stage it", and it has not been relaxed.
- **The approval workbook IS the release list, in both directions.** Two client rulings.
  *(2026-09-04)* A check carrying a bill from that workbook belongs at READY_FOR_RELEASE —
  `scripts/backfill-available.ts`, which also demotes any READY_FOR_RELEASE check NOT on the list.
  *(2026-09-10)* A voucher present on an OLDER approval workbook and absent from a NEWER one was
  released in between — `scripts/backfill-released-dropped.ts`.

  The second **writes RELEASED over an ERP that says otherwise**, knowingly: of the 51 vouchers that
  dropped between 4 and 7 September, 49 of the checks they name were still `Balanced` in Acumatica
  and not one was `Closed`. On the usual rule that means "not released". The client resolved it:
  *"Those are not in the list of course will reflect balance in acumatica because no update yet for
  the released checks in acumatica."* The ERP entry lags the counter — the very lag this system
  exists to close. Every audit row records what Acumatica said at the time, so the disagreement is
  visible rather than buried. `releasedAt` and `releasedById` stay null: neither is knowable from a
  workbook, and a fabricated timestamp on a release record is worse than none.

- **A refused approval-workbook row lands in `StagedBill` and shows on `/admin/staged`.** This is
  why `AP-ST042652` was missed: the importer refused the row correctly and reported it correctly, to
  a terminal, once, during a run nobody was watching. `StagedBill` is deliberately **not** a
  `StagedCheck` — every staged check carries an `impliedStatus` and a bill has none, and this
  workbook's `FINANCE REMARKS = AVAILABLE` is evidence, never an instruction. It carries no amount
  and no vendor, because a bill's `Detail Total` displayed beside check amounts is read as a
  check's figure sooner or later.
- **THE REGISTER’S AMOUNTS ARE NOT RELIABLE. ACUMATICA’S ARE.** Measured 2026-09-10, and it is the
  strongest evidence yet for the client’s "follow Acumatica" ruling. The 9 September register import
  changed 94 amounts on checks Acumatica also knows. All 94 were read back from the live ERP:
  **the register was wrong in every one, Acumatica right in every one.** Seven moved by more than
  PHP 10,000 and one turned 217,037.94 into 27,037.94 — a leading digit dropped. The small ones look
  like plausible net-to-gross corrections (3,928.57 -> 4,000.00 is exactly 12% VAT) and are not:
  they are wrong too. **Do not accept a register amount over an Acumatica one, and do not reason
  from the shape of the difference.**

  The same import also moved **1,958 checks to a company Acumatica contradicts**, silently, because
  `companyId` and `amount` are both in `IMPORT_WRITABLE`. Both were restored from a pre-import
  snapshot, with 2,052 audit rows. **The ruling is still not enforced in code** — nothing in
  `upsertCheck` stops a register row overwriting a field the ERP owns, and this was caught only by
  diffing against a snapshot taken by hand beforehand. **Snapshot before any bulk write to
  production**: it is the only reason that recovery was exact rather than reconstructed.

- **Acumatica bank-prefixes 90% of its check references** (`BPI 6000240287`) while the register
  writes them bare. `canonicalCheckNumber` reconciles them — without it the same check stores twice.
- **`Branch` from Acumatica is space-padded** (`"A1+       "`). `orNull` trims it; an untrimmed read
  resolves every payment to no company.
- **`PaymentMethod` decides `isCheque`**, alongside the China-branch rule. **`CHK` and `CASH` are
  checks; `TT`, `DEBIT ADV`, `BT`, `MC` are not** and must not offer a SIGN button. CASH was a
  non-check until 2026-10-23, when the user ruled: *"all the AP issued CV will be paid thru checks,
  its either will be checks pay to cash or to be encashed"* — and the feed filter in `lib/sync/run.ts`
  asked for CHK only, so `CV-ST021234` (`6000354949`, BPI-S-8879, 19 Oct, CASH) was never fetched,
  never held, never in the portal. Measured that day on Go-Live 2026: CHK 13,496, TT 1,680, CASH 271
  (242 PCF-SITIO petty-cash replenishments numbered `PCF26-xxxx`, 29 on bank books, 26 with a plain
  check number — 21 of those held from the register, `6000353877` and `6000354949` not held at all);
  Manufacturing 1 CASH. **The user ruled the PCF-SITIO ones are checks too.** Since the sync reads
  `(PaymentMethod eq 'CHK' or PaymentMethod eq 'CASH')` — the payments inquiry accepts that `or`,
  measured, unlike the bills inquiry — and `CHEQUE_PAYMENT_METHODS` in `map.ts` is the same pair;
  keep the two in step. A CASH check numbered `PCF26-xxxx` is not a bare number, so it stages
  NO_CHECK_NUMBER like the 275 CHK payments numbered that way already do (2026-09-04 ruling, not
  revisited) — it does not appear on the dashboard. The BILLS read needs no change: its `CHK` is
  the DOCUMENT type (Payment), and CV-ST021234's application to AP-ST045103 maps as it is. A full
  re-read (`scripts/sync.ts <TENANT> --full`) is what brings the CASH checks in; the incremental
  read sees only those modified after the watermark.
- **Acumatica's `CashAccount` column is the CHECK BOOK, not this system's cash account.** It states
  `BPI-S-4636`, `MBT-A-4155`, `BDO-A-3838` — the eight `CheckBook` codes the register used — while
  `CashAccount` here holds six register labels (`BPI STK`, `MBTC A1+`, …). Until 2026-10-02 `map.ts`
  dropped it (`checkBookCode: null`) and looked it up as a cash account, which never matches: 3,844
  Acumatica checks had no check book and 3,501 checks neither, 1,091 of them dated since the register
  stopped. The sync now records it; `scripts/backfill-check-books.ts` fills the rest — **run
  2026-10-05 by the user, `--apply` on both tenants (GOLIVE twice: before and after §E dropped the
  company check), 3,055 `check_book_backfilled_from_acumatica` rows, snapshots
  `snapshots/check-books-<TENANT>-2026-10-05T*.json`. After: 12,129 of 13,037 checks carry a book;
  908 do not — 868 Acumatica payments on non-book accounts (`PAYROLL` 864, `MBT-S-9048` 3, a
  separate account from `MBT-A-9048` with no CheckBook row, `RSB-S-0869` 1) and 40 register-only.**
  A check book is a bank account shared across companies — the register itself filed
  STK, A1+, HAMFI and IND checks under one book — so neither the sync nor the repair checks the book's
  company (user ruling 2026-10-05, spec §E). NUMBERING groups by check book. **Since 2026-10-06 a
  check's ACCOUNT is its check book, else the register label** (`accountWhere` in `lib/queries.ts`,
  the one rule): the dashboard BANK filter (the `cashAccount` URL parameter now carries a check-book
  id or, for a check with no book, a label id — ids are cuids, unique across both tables), the BANK
  column and its sort, the options list (books first), RECON's account filter, grouping and bank, and
  the READY FOR RELEASE guard (`CASH ACCOUNT / CHECK BOOK`). Measured that day: the label alone
  covered 1,342 of 13,080 checks, left 10,026 of 10,758 released checks in no RECON account, and
  **blocked READY FOR RELEASE on 930 of the 1,370 SIGNED/pending checks**. Where a check has both,
  the book wins (follow Acumatica). The forecast's bank split, `/vouchers`' BANK column and portal
  event bodies still read the label first and fall back to the book.
  `PCF-SITIO`, `PAYROLL`, `PCF-SILANG`, `RSB-S-0869`, `MBTC-S-988` are no check book. **`PAYROLL` is the clearing account, a BPI CASH ACCOUNT since 2026-10-16** (user ruling; companyId STK decides nothing), and `MBT-S-9048` an MBTC check book (**retired 2026-11-03: it is an alias of `MBT-A-9048`, see spec §K**): `scripts/add-clearing-accounts.ts <TENANT> [--apply]` (`lib/admin/clearing-accounts.ts`) created both and, run that day by Claude on the user's "do it", linked 818 PAYROLL checks (GOLIVE 784, MANUFACTURING 34; one `cash_account_linked_from_acumatica` row each) and set 10 on MBT-S-9048, snapshots `snapshots/clearing-accounts-<TENANT>-2026-10-16T03-*.json`. Before it those checks had no account, so READY FOR RELEASE and MARK RELEASED refused them.
- A voided check is **two feed rows** under one reference; the original's positive amount survives.
  **`collapseVoidPairs` pairs on company + payment reference + check number** (2026-10-06). Keyed on
  the number alone it treated a RE-ISSUE on the same number as the void's other half and flagged the
  live check voided — `1791361374` (CV-A1009798, Closed) was VOIDED here that way. And
  **`upsertCheck` stages a payment whose `(company, number)` is held by a DIFFERENT payment reference**
  (`StagedReason.SHARED_NUMBER`, migration `20261006000100`, shown on `/admin/staged`): before, the two
  payments took turns writing over one check and the voided one voided the live one. Measured that day:
  5 Go-Live numbers — void + re-issue `1791361374`, `1791361447`, `1791361448`; two live payments
  `6000338856`, `6000349314`. Fix the number in Acumatica, or settle it by hand.
- **A payment that leaves the sync's scope is never read again** (2026 + CHK-or-CASH): `PCF26-0244` became
  CASH in Acumatica (a non-check until 2026-10-23) and stayed a SIGNATURE_PENDING check here. `scripts/sync.ts <TENANT> --full`
  now (a) snapshots the tenant's checks to `snapshots/payments-full-<tenant>-<ts>.json` first and
  (b) re-reads, one request per reference, every LIVE check whose payment is no longer in the scoped
  feed (`lib/sync/out-of-scope.ts`), through `upsertCheck` — status untouched. `--full --dry-run` lists them.
- **Full check 2026-10-06** (read-only, both tenants, against the live feed): 0 company or check-book
  mismatches, 0 sync errors, 0 parked portal events. Found and settled on the user's rulings:
  **102 amounts differ from Acumatica** (40 RELEASED with the register's amount, the rest voided or
  cancelled checks holding none or a reversal's negative) because the incremental sync re-reads only
  changed payments — **fixed by `scripts/sync.ts <TENANT> --full`**, which also renumbers and voids
  `17913405552` → `1791405552` (Voided in Acumatica). The user ruled the full re-read may write
  Acumatica's amount onto `6000353252` and `1791361447`, which hold none. **63 checks CANCELLED only by
  the register** (its CANCELLED / CHECK FINDING sheets) are live in Acumatica: the **43 Closed → RELEASED**
  ("follow acumatica"), and Finance ruled the **20 Balanced** in `CANCELLED VS ACUMATICA 2026-10-06..xlsx`
  (NEW STATUS column): **4 AVAILABLE → READY FOR RELEASE, portal told**; **8 STALED → stay CANCELLED,
  `isStale` set, shown as a STALED tag** on the list and the check page (the column's first writer);
  **8 CANCELLED → unchanged, to be voided in Acumatica**. `scripts/reconcile-with-acumatica.ts
  "<file>" [--apply --user <email>]` (`lib/admin/acumatica-reconcile.ts`) does both, snapshot first, and
  must run AFTER the full re-read. **Since 2026-10-07 it also reads the live feed for voids** (`6000319193`/`94`: `Payment / Closed` beside a pending `Voided Payment / Balanced` — never released) and **re-points a check holding a voided payment to the live one staged SHARED_NUMBER on its number** (`1791361448`: the old-code full runs of 2026-10-06 16:07/16:20 Manila left it on CV-A1009778; `repointed_to_live_payment`). Earlier note: it reads the stored `acumaticaStatus`, and before the re-read
  `6000319193`'s held the reversal row's `Closed`. Its Closed set also takes `1791361374` and two 2025
  register-cancelled checks (`6000272567`, `6000290809`). BPI-A-8879's two `1791…` checks were on the
  wrong cash account; Finance fixed them in Acumatica the same day.
  **The reconcile RAN ONCE, 2026-10-07 08:05 Manila, by the user — NEVER RUN IT AGAIN.** After the
  full re-reads (GOLIVE 2026-10-06 13:30Z, 196.7 min, 12,898 fetched, 0 errors; MANUFACTURING 141, 0 errors;
  snapshots `snapshots/payments-full-<TENANT>-2026-10-06T13-*.json`): re-pointed 1, released 47,
  staled 8, readied 4 (snapshot `snapshots/reconcile-with-acumatica-2026-10-07T00-05-55-565Z.json`).
  The full check after it: 0 amount, number, company, book or void differences on either tenant.
  **The 4 AVAILABLE were wrong and are undone.** `1791361448`, `6000308871`, `179174`, `179175` sit
  only on the 10.05 register's CANCELLED sheet (column A: CANCELLED / STALLED CHECK, no DATE
  RELEASE), and the user ruled the READY count must stay what the portal shows (67): restored from
  that snapshot to CANCELLED (`reconcile_available_reverted`), no portal event ever delivered (their
  MARK_AVAILABLE closed unsent). In between they were marked RELEASED by mistake
  (`released_confirmed_by_user`) and put back (`release_confirmation_undone`) — the user's "yes they
  were released" meant `6000330355`, `6000338827`, `6000338828`, `6000337892`. **Lesson: a Finance
  verdict file is evidence, not an instruction — cross-check it against the latest register before
  applying, and when the user confirms "they were released", name the check numbers back first.**
  **Deliver reports every release since go-live** (2026-10-07, `queueReleasedForStale`): a routed
  RELEASED check with an APV, a release day on/after `REPORT_RELEASES_FROM` (2026-09-01) and no
  RELEASED event is queued — no longer only those first announced available — 50 per kick (Deliver
  now, the cron, action kicks), newest first. 1,124 qualified; the user's 4 above (released 1 Oct,
  their availability withdrawn with Detail1 before the portal heard of them) were in the first 50,
  all accepted. `1791405389` is READY with no portal event and that is right: it was readied FROM the
  portal (`backfilled_ready_from_portal`, 2026-09-26), so the portal already lists it — the app's 67
  READY and the portal's 67 CHECKS AVAILABLE are the same 67.
- **Which check pays an AP voucher is answered on `/vouchers`, and `CHECK BY VOUCHER.xlsx` is
  its extract.** The Finance Executive Report's `AP Local` sheet used to find a payable's check
  with three `VLOOKUP`s into the released sheets of `CHECK MONITORING <date>.xlsx`; the register
  was retired on 2026-09-10 and a `VLOOKUP` into a stale external returns its last cached value for
  ever rather than failing. A handover asking Finance to repoint those formulas was written and
  then withdrawn the same day on the client's ruling: *"I want the report to be done in the portal.
  And report can be extracted from there."* Measured over `AP Local`'s 1,472 distinct vouchers: 986
  name exactly one check, 54 name more than one (46 of them a re-issue with a single live check),
  432 name none. The old formulas could answer 2 of the 1,472, because they looked only at released
  checks and `AP Local` is the OPEN payables ledger. `resolveVoucherRows` in
  `lib/export/voucher-index.ts` is the one judgement both the screen and the file are built from;
  do not add a second. The extract keeps its fixed filename, fixed sheet `INDEX` and the timestamp
  in `$A$2` — a stable shape costs nothing — but nothing outside this system depends on them now.

## State

Plans 1 and 2 complete. Plan 3 is superseded by `docs/superpowers/plans/2026-09-26-portal-outbox-delivery.md` (spec
`2026-09-26-check-monitoring-integration-design.md`): the outbox is delivered by
`lib/sync/portal-outbox.ts` to the portal's `POST /api/integrations/check-monitoring/events`
with `PORTAL_BASE_URL` / `PORTAL_TOKEN` (a bearer, no session), latest event per check wins,
`/admin/portal` shows what parked. Pickup confirmations back (old Task 6) remain a follow-up.
**2,380 tests across 167 files** (arithmetic: 2,354 plus 26 for the availability approval on 2026-11-05 — `domain/availability-approval` 15, new; `actions/actions` +2, `settings/registry` +3, `settings/actions` +1, `notifications/messages` +3, `notifications/notify` +1, `admin/ready-upload` +1; those files plus `admin/actions`, `module-nav` and `settings/read` ran green, 143/143 across two runs, not a full run; the first run failed 40 because `resetDb` did not yet truncate `AvailabilityRequest`). **2,354 tests across 166 files** (arithmetic: 2,341 plus 13 for NUMBERING §K on 2026-11-03 — `check-book-alias` 3 and `admin/merge-check-book` 5, both new, `admin/check-books` +1, `import/upsert` +1, `numbering-view` +3; those five files ran green, 110/110, not a full run). **2,341 tests across 164 files** (arithmetic: 2,337 plus 4 in `manila-format`, new, 2026-11-03). **2,337 tests across 163 files** (arithmetic: 2,333 plus 4 for NUMBERING §J on 2026-11-03 — `numbering-view` +2, `export/numbering-workbook` +2, both files green). **2,333 tests across 163 files** (arithmetic: the 2,316 below plus 17 for NUMBERING §I on 2026-11-03 —
`numbering/series` +8, `numbering/query` +3, `numbering-view` +3, `numbering/inventory` +1,
`numbering/inventory-notes` +1, `export/numbering-workbook` +1; those seven files ran green, 133/133,
in 130.8 s, not a full run). **2,316 tests across 163 files** (measured, full run 2026-11-03, 49.0 minutes, on
`feature/portal-check-list`: 2,309 passed and 7 failed — 3 hook timeouts in `admin/users` that passed
alone, and 4 real failures that were on master since the 2026-10-29 detach rule and are fixed in the
same branch: `actions/actions` and `import/upsert` still expected a void to queue a CANCELLED event,
and `actions/portal-cancel` / `admin/detach-cancelled-apvs` expected the detached bill's amount as
`1.50` where `detachFromBills` wrote Decimal's `1.5` — the code now writes `toFixed(2)`, rule 8. The
check list added `integrations/portal-check-feed` and `sync/portal-checks`, and extended
`integrations/portal-client`, `sync/portal-kick`, `sync/modes`). **2,065 tests across 137 files** (measured, full run 2026-10-10, 53.9 minutes, on `feature/self-registration-wt` before its merge: 2,063 passed and 2 failed on a Neon connection drop in `sync/portal-kick`, which passed 7/7 when re-run alone; self-registration added `auth/registration-throttle` and `actions/signup`, and extended `admin/users`, `admin/user-actions`, `settings/registry`, `public-paths`)  **1,918 tests across 130 files** (measured, full run 2026-10-05, 52.0 minutes, 0 failures, on
`feature/shared-books` after merging master 7591c6d — shared check books on top of the PO work; the
meta-tags commit 3b341f7 merged after it touches no tested module and passed tsc and the pure tests)
— 1,913 across 130 (measured 2026-10-05 on `feature/po-from-acumatica` after merging
master b190a79: one full run, 1,903 passed and 10 failed on 5-second timeouts in 7 files while this
machine's connection to the Neon test database was intermittently dropping — "Can't reach database
server" — and all 7 files then passed when re-run alone, 185/185; PO from Acumatica added
`integrations/acumatica-bill-refs`, `sync/bill-refs`, `sync/modes` and extended `queries`,
`sync/cron-route`, `sync/run`, `sync/bills`, `admin/sync-overview`, `schema`, `export/route`) —
1,805 across 126 (measured, full run 2026-10-05, 45.4 minutes, on
`feature/check-books`: the check book from Acumatica, `backfill-check-books`, NUMBERING by book —
`admin/check-books` new, `import/upsert`, `integrations/acumatica-map`, `numbering/query`,
`export/numbering-route` extended. 5 cases in `admin/actions`, `admin/backfill-apv-numbers` and
`admin/repair-cr-receipts` hit the 5 s test timeout while the remote test database was slow and passed
when re-run alone, 35/35) — 1,792 across 125 (measured, full run 2026-10-02, 58.3 minutes — the remote test
database was slow that hour — 0 failures, on `feature/numbering-staged`: STAGED dotted re-uses on
NUMBERING, +15 in `numbering/series`, `numbering/query`, `export/numbering-workbook`) — 1,777 across 125 (measured, full run 2026-10-01, 31.0 minutes, 0 failures, on
`feature/apv-po-and-table` — parts B and C — after merging master) — +152 and 4 files over the 1,625:
`sync/bills` and `integrations/acumatica-bills` (new, the BILLS read), `list-sort` and `column-filters`
(new, part C), and `queries`, `dashboard-view`, `dashboard-links`, `table-columns`, `export/*`,
`actions/bulk-actions`, `import/upsert`, `sync/run`, `sync/cron-route`, `admin/sync-overview` extended.
1,625 across 121 (measured, full run 2026-10-01, 23.0 minutes, 0 failures, on the
merge of both branches below). Two branches measured from the same 1,543 base on 2026-10-01, each 0 failures:
**1,600 across 120** on `feature/numbering-cancel-guard` before its merge (22.2 minutes; the CANCELLED
guard, close-unmatchable-cancelled and NUMBERING, +57 across 7 new files), and **1,568 across 114** on
branch `feature/signing-schedule` before its merge (22.2 minutes) — the signing schedule
(`actions/revert-signature` new; `domain/auto-sign`, `sync/auto-sign`, `actions/auto-sign` rewritten;
`domain/check-status`, `settings/registry`, `sync/cron-route`, `queries`, `dashboard-view`,
`actions/bulk-actions`, `actions/server-actions`, `row-receipts` extended; `scripts/auto-sign-backlog.ts` deleted)
— 1,543 across 113 (measured, full run 2026-09-29, 21.8 minutes, 0 failures,
on branch `feature/totals-filters-all-checks` before its merge) — 1,537 across 113 before the final-review fixes
(`dashboard-view` +5: `totalsHref` 3, `dashboardScreen` fails closed 1, RESET / incomplete
toggle stay on the list 1; `actions/bulk-actions` +1: a whitespace filter refuses); 1,519 across 113 before the TOTALS-screen filters and ALL
CHECKS (`dashboard-view` +5, `export/dashboard-params` +3, `dashboard-links` +1, `queries` +6,
`actions/bulk-actions` +3; measured, full run 2026-09-28, 30.8 minutes; one case in
`actions/receipt` failed in that run and passed alone straight after — a timeout while a
production script shared the connection, not a defect) — 1,497 across 112 before the stated
release date (`admin/stated-release-dates` 18, `queries` +4); 1,479 across 112 before the DATE RELEASED filter (`queries` +5, `export/dashboard-params` +6, `export/report` +3, `table-columns` +2, `dashboard-links` +2); 1,404 across 104 before the portal outbox delivery (`schema` +1, `actions/portal-cancel` 3, `integrations/portal-client` 13+, `sync/portal-outbox` 25+, `sync/portal-kick` 5, `sync/cron-route` +1, `admin/portal-overview` 2, `admin/portal-actions` 3, `scripts/portal-backlog` 3, plus the void-path assertions in `actions` and `import/upsert`); 1,380 across 101 before the two-screen dashboard and per-row OR (`dashboard-view` +2, `queries` +1, `row-receipts` 7, `receipt-form` 6, `bulk-actions` +5 with four receipt cases rewritten, `release-keeps-receipt` 3); 1,380 across 101 measured earlier the same day — 1,350 across 98 before auto-sign (`domain/auto-sign` 9 —
Manila calendar days and the exact boundary, `actions/auto-sign` 3, `sync/auto-sign` 8 — the plan's
five plus NOT_FOUND-skip, time budget and the calendar-vs-72h list case,
`sync/cron-route` +3, `settings/registry` +1 and one case renamed); 1,344 across 97 before the for-release list (`admin/release-list` 6); 1,332 across 96 before the register catch-up (`admin/register-releases` 12); 1,327 across 95 before the module bar (`module-nav` 5); before that 1,290 across 89, then the outstanding-checks report +37
(`recon/outstanding` 12, `recon/query` 7, `recon/summary` 6, `recon-view` 5, `export/recon-workbook` 4,
`export/recon-route` 3). Before that: 1,254 across 85, then the settings +36
(`settings/registry` 12, `settings/actions` 7, `settings/read` 5, `actions/settings-actions` 3, one case in each
of six consumer files, `actions/clearing-bulk` +1, `domain/details` +1, `planned-outflow/actions` +1).
Before that: 1,218 across 82, then the forecast calibration +36
(`planned-outflow/actions` 13, `domain/planned-outflow` 6, `forecast/query` +4, `actions/planned-outflow-actions` 3,
`domain/details` +2, `actions/update-details` +2, `forecast/matrix` +2, `actions/server-actions` +1,
`export/forecast-workbook` +1, `export/audit-workbook` +1, `admin/audit-query` +1). Before that: 1,176 across 77, then the Finance inputs +42
(`admin/repair-cr-receipts` 9, `clearing-paste` 9, `domain/details` 6, `actions/update-details` 6,
`actions/clearing-bulk` 5, `actions/server-actions` +4, `import/parse` +1, `import/upsert` +1,
`domain/check-status` +1). Before that: 1,048 across 61 after the voucher screen; then scheduled-sync +21
(`sync/run` +5, `sync/scheduled` 5, `sync/cron-route` 6, `sync/staleness` 5), the middleware hotfix
+4 (`public-paths`), the cash-outflow forecast +58 (`forecast/buckets` 19, `forecast/query` 14,
`forecast/matrix` 8, `forecast-view` 8, `export/forecast-workbook` 6, `export/forecast-route` 3),
the release reversal +18 (`domain/check-status` +1, `domain/reversal` 4, `actions/reverse-release`
10, `actions/server-actions` +3), and the audit screen +27 (`audit-view` 14, `admin/audit-query` 7,
`export/audit-workbook` 3, `export/audit-route` 3). The file count is read off disk
(`find tests -name "*.test.ts" | wc -l`, 2026-09-11).
Arithmetic on two measured figures, not a reading off one full-suite run: the whole suite takes ~20
minutes because every test crosses to ap-southeast-1, so it is run before a merge, not per change.

Production is `check_monitoring_prod` on Neon. Both outstanding migrations were applied on
2026-09-10 — `20260907000000_check_apv_numbers_and_staged_bill` and
`20260910000000_check_receipt_type` — so schema and database agree. As of that evening:
11,870 checks, 9,224 carrying an AP voucher (from 84), 287 bills, 0 staged bills.
Migration `20261005000100_acumatica_bill` (the `AcumaticaBill` table) must reach production BEFORE the deploy that carries it: the list, export and print query the table on every request.

### What is missing, measured 2026-09-10 — in priority order

1. **The scheduled sync is LIVE** — deployed, `CRON_SECRET` set, production migrated, first
   scheduled run 2026-09-11 08:42 Manila: both tenants, one second each, 0 errors, 27 rows
   updated. Item 1 is closed; what follows is how it works and what switching it on took. `vercel.json` carries
   two crons on `/api/cron/sync`: `"0 4 * * *"` and `"0 10 * * *"` UTC — 12:00 and 18:00 Manila,
   daily. Hobby's limit is once per day PER JOB, so each further run is a further entry in
   `vercel.json`. The route authenticates with `CRON_SECRET` on its first line and refuses
   to run while it is unset; it never runs FULL — no watermark means a recorded refusal on
   `/admin/sync`, and a first read stays a terminal job (`scripts/sync.ts`). `runSync` now refuses
   to overlap another run of the same tenant inside `SYNC_IN_PROGRESS_MINUTES` (10), records
   `trigger` (MANUAL | SCHEDULED), and writes a true `finishedAt` — every run before 2026-09-11
   has `finishedAt = startedAt`, because `finish` wrote the start instant. The dashboard states
   ACUMATICA LAST READ per tenant and warns past `STALE_AFTER_HOURS` (30).
   **To go live:** set `CRON_SECRET` in Vercel, `node scripts/migrate.mjs prod --confirm`,
   `npx vercel --prod`, then trigger the job once from the Vercel dashboard and confirm two
   SCHEDULED rows on `/admin/sync`. Until that is done, item 1 is still open in production.
   **Auto-sign** (rewritten 2026-10-16, spec `2026-10-16-auto-sign-monday-and-tuesday-design.md`, replacing the 2026-10-01 Monday-only rule): the cron runs at 12:00 and 18:00 Manila (`0 4 * * *`, `0 10 * * *`); on a Manila Monday it signs every SIGNATURE_PENDING Acumatica check first read before that Monday (last Tuesday to Sunday and any older backlog — user ruling 2026-10-16), and on a Manila Tuesday every one first read before that Tuesday (Monday's checks and any Monday leftover), so Monday's checks sign on Tuesday and the rest on the next Monday (`signedById` null, one `auto_signed` row with `rule: 'WEEKLY'` and `runDay`, no portal event; rows written before 2026-10-16 say `rule: 'MONDAY'`). Measured 2026-10-16 before the change: 727 pending, not one `marked_signed` row ever — SIGN ALL had never been pressed. SIGN ALL on the SIGNATURE PENDING list still signs sooner (server-confirmed like RELEASE ALL, every Finance user). `SIGNED -> SIGNATURE_PENDING` is `revertSignature`, every Finance user, reason optional, one `signature_reverted` row; a reverted check is never auto-signed again. Setting `autoSign.mondayEnabled` (1/0, key kept, label "AUTO-SIGN ACUMATICA CHECKS ON MONDAY AND TUESDAY"). Every run writes one `auto_sign_run` row (read by LAST AUTO-SIGN on `/admin/sync`: "N check(s) signed", "not a Monday or Tuesday - nothing due", "switched off in settings") - `IDLE` Wednesday to Sunday; a FAILED run turns the cron response 500, and the route's 50-second time budget still applies. A run cut off by the budget is continued by the next run — the 18:00 run, else Tuesday's for Monday, else next Monday's for Tuesday — and the FAILED message says which (`LAST_RUN_UTC_HOUR` in `lib/sync/auto-sign.ts`, tied to `vercel.json`). Rule 4 is untouched: the sync never writes status.
   **Signing is MANUAL since 2026-10-22 (user ruling): "We will manually transfer from pending signature to signed."** Auto-sign is to be switched off with `autoSign.mondayEnabled = 0` on `/admin/settings` (the code is unchanged; the setting is the switch). The same day `scripts/revert-recent-signed.ts 2026-10-19 --apply` (run by the user) returned the 48 SIGNED checks first read since 19 Oct — all auto-signed, all first read 19 Oct — to SIGNATURE_PENDING through `revertSignature`, one `signature_reverted` row each, snapshot `snapshots/revert-recent-signed-2026-10-21T23-47-59-581Z.json`; 0 left. Do not re-enable auto-sign without asking. **The setting was not enough: on Tuesday 2026-10-27 the 12:00 run signed 137 of Monday's checks** (the switch had never been set to 0, or was reset). All 137 were returned to SIGNATURE_PENDING the same day by `scripts/revert-recent-signed.ts 2026-10-26 --apply` (snapshot `snapshots/revert-recent-signed-2026-10-27T08-11-35-599Z.json`) — and the user then said not to revert them, so putting those 137 back to SIGNED is an open item, theirs to call. **User ruling 2026-10-27: the rule is off in code.** `runAutoSign` records DISABLED and signs nothing, `autoSign.mondayEnabled` is gone from the registry (a stored row is ignored), and /admin/settings has no WORKFLOW group. `lib/domain/auto-sign.ts` and `listAutoSignCandidates` stay as the record of the retired rule; nothing signs from them.
   SIGN ALL and RELEASE ALL share one unexported helper `runConfirmedAll` (`app/checks/bulk-actions.ts`) and one client form `components/ConfirmAllForm.tsx`; the confirm block stays mounted while `?confirm=` is set, so the success report stays on screen after a run. SIGN ALL is offered only on the SIGNATURE PENDING list with no search and the incomplete toggle off; its set excludes non-checks (DEBIT ADV, CASH) and the page states how many. The bulk bar's REVERT TO PENDING has its own optional reason box.
2. ~~**One active FINANCE_ADMIN**, of three active users.~~ **Closed: the user reports three active
   FINANCE_ADMINs (2026-10-16).** It mattered because admin-only actions (revert availability, the
   release reversal below) and user administration would lock with one forgotten password — which
   had already happened once. The last active admin still cannot be deactivated or demoted (rule 6).
3. **The audit trail can be read** (built 2026-09-11): `/admin/audit`, FINANCE_ADMIN only. It opens
   on people's actions — measured that day, 4 of 65,269 rows; the rest are imports, backfills and
   the sync — with SYSTEM ROWS one toggle away, because the 10 September restorations are SYSTEM
   rows and are the record an auditor asks for. Filters: action (from `SELECT DISTINCT`, never a
   list), user, check number (through the join, so the 17,087 detached rows cannot match it and
   the page says so), Manila dates. Keyset pagination on `(createdAt, id)`; four indexes in
   `20260911000200_audit_log_indexes`, which must reach production before the deploy. Excel extract
   of the filtered range at `/api/export/audit`. `writeAudit` remains the only writer.
4. **Notifications are in-app** (built 2026-10-16, spec `2026-10-16-notifications-design.md`): a
   NOTIFICATIONS link with the unread count in the header and `/notifications`. One `Notification`
   row per recipient. FINANCE_ADMINs are told when a scheduled read (payments, BILLS, BILL_REFS) or
   auto-sign FAILS or is REFUSED (every run), when a tenant goes past `sync.staleAfterHours` (once
   per stale stretch, `dedupeKey`), and when a portal event PARKS (in `settle`'s transaction, once
   per event). Every other active user is told once per READY FOR RELEASE action (single or bulk,
   the actor excluded). No email. Not notified, and not reachable: a supplier's pickup booking
   (rule 12). If the cron stops running, the stale notice cannot fire; the dashboard's stale line
   is the backstop. Migration `20261016000100_notification_recipients` must reach production
   before the deploy (the header queries it on every page).
5. **3,718 staged rows with no owner** — no ageing, no alert, nobody assigned.
6. **"Acumatica wins" is not enforced in code.** See the amounts note above.
7. **No general snapshot step before a bulk write.** The 10 September recovery depended on one
   taken by hand. `scripts/repair-cr-receipts.ts` (2026-09-11) builds its own — a JSON of every
   affected row under `snapshots/`, written before the first write — and is the pattern for the
   next repair; nothing yet makes it automatic for `upsertCheck`.
8. **A release can be reversed** (built 2026-09-11, client design of 2026-09-10). `reverseRelease`
   in `lib/domain/actions.ts`: FINANCE_ADMIN only, mandatory reason, back to READY_FOR_RELEASE with
   the availability kept and the collection cleared, one `release_reversed` audit row recording
   what was undone. **Refused outright when a receipt is on record** — the supplier's own paper —
   and, an addition approved the same day, **when any clearing is recorded**: money the bank has
   paid cannot be un-handed-over. Both refusals live in `lib/domain/reversal.ts`, which the page
   reads too, so an admin is told why rather than shown a button that would refuse. The portal is
   told `RELEASE_REVERSED` — a fourth `PortalEventKind`, delivered via `POST /api/checks/:id` with
   `status: AVAILABLE_FOR_RELEASE` when Plan 3 delivers — and deliberately NOT `REVERT`, which the
   portal reads as withdrawn for re-upload. Measured before building: none of the 9,594 released
   checks carries a receipt, `releasedAt`, or clearing, because `markReleased` has never run in
   production; both refusals are forward-looking. Migration
   `20260911000100_portal_event_release_reversed` must reach production before the deploy.
   (Reverting availability, READY_FOR_RELEASE -> SIGNED, has been on the detail page since
   2026-09-10.) **A check released outside the app has no availability to keep (2026-11-03).**
   The 11,225 RELEASED checks the register delivered carry no `availablePickupDate`, and the
   portal refuses a RELEASE_REVERSED without one: `6000353139` (register-released, reversed by
   Finance with "CHECK AVAILABLE AS OF 11.03.2026") parked that way, and `revertAvailability`
   then refused REVERT TO SIGNED while the reversal waited — the check could go neither way.
   Unblocked by hand that day (pickup date 2026-11-03 written with an `available_pickup_date_set`
   row, the event re-queued, snapshot `snapshots/pickup-date-6000353139-2026-11-03T08-55-58-852Z.json`).
   Since then `reverseRelease` takes `availablePickupDate`: REQUIRED when the check has none
   (`PICKUP_DATE_REQUIRED`, nothing written) and then recorded with `readyById` / `readyAt` as the
   availability this reversal creates (the audit row's `details` carry it); a check readied here
   keeps its own date and ignores a supplied one. The check page shows the date box only for a
   check with none. RETRY on `/admin/portal` cannot clear a MISSING_DATE park on its own — the
   check needs the date first.
   **The same day, two rulings widened it.** *(1) "This should not reach the portal"* (on
   `6000353139`, whose parked reversal and its REVERT were then closed unsent by hand, snapshot
   `snapshots/quiet-revert-6000353139-2026-11-03T09-15-46-022Z.json`): **a reversal is queued for
   the portal only when the portal was told of the release** — a RELEASED event delivered or
   IN_FLIGHT (`deliveredToPortal`, `lib/integrations/portal/delivered.ts`: SYNCED and not closed
   unsent; the closed-unsent prefixes are `superseded by`, `stale:`, `unmatchable:`, `closed
   unsent:`). Every check the register delivered at RELEASED, and any release the outbox has not
   sent yet, reverses silently; the audit row's `details` carry `portalTold` and `portalEvent`.
   *(2) "Make a selection where the checks will reside next after reversal":* REVERSE RELEASE
   has a DESTINATION (`components/ReverseReleaseFields.tsx`, `ReversalDestination` in
   `lib/domain/actions.ts`) — READY FOR RELEASE (the original one-rung reversal, availability kept
   or created) or SIGNED (withdrawn: availability cleared as `revertAvailability` clears it, no
   date needed; the ladder now has `RELEASED → SIGNED`, walked only by `reverseRelease`). When
   the portal was told: READY sends RELEASE_REVERSED, SIGNED sends ONE REVERT — **the portal
   applies a REVERT to a RELEASED bill since 2026-11-03** (`src/integrations/check-monitoring.js`,
   REVERT case: un-released silently, then withdrawn as an available bill is; test in
   `test/checks-cm-pickups.test.js`; edited in the user's ZIP extract
   `~/Downloads/Supplier-Database-claude-reissue-revives-cancelled-row`, the tree the 2026-10-29
   portal deploy came from, NOT a git checkout and its tests not run there — it must be carried
   into the portal repo and deployed before a SIGNED reversal of a portal-known check is used;
   until then that REVERT is a noop at the portal and the bill stays paid there). An INTERNAL
   check gets the quiet RELEASE_REVERSED for either destination (REVERT is never sent for one,
   rule 2), which is why `kindMatchesStatus` admits RELEASE_REVERSED on a SIGNED check.
9. The test suite takes ~20 minutes because every test crosses the South China Sea. A local Postgres
   would make it ~2. It is the tax on every deploy.
10. **The cash-outflow forecast is BUILT** (2026-09-11) — `/forecast`, on the check date read as
   PRESENTABLE FROM, because no pickup or release date has ever been recorded (measured: null on
   every row) and a check's date is the day from which it can be presented. Live checks by bank
   and by stage in Finance's own ageing buckets; the file is the view. What it cannot yet show is
   actual outflow by day: that begins the day releases go through the app and `releasedAt` fills.
   Of the other three reports Finance named, **the bank reconciliation's check side is built**
   (2026-09-12): `/recon` gives every cash account's outstanding checks — released and not
   cleared — as of a day, the OC column of the Cash Balance sheet, with its extract; deposits in
   transit and the balances stay with the bank statement, whose import waits for a sample export.
   Hedging and the foreign outlook are not buildable here; the voucher-index spec's closing section
   records why. **Calibrated 2026-09-12:** Finance types the day a check is expected to leave the
   bank (EXPECTED OUT, on the check page; the forecast places it there) and planned non-check
   outflows — payroll, tax, loans, transfers — as one-off lines on `/forecast/planned`, open until
   marked PAID or CANCELLED, never deleted. The daily cash position is no longer checks only.
11. **Closed 2026-10-05:** check books are shared across companies (spec §E); `CheckBook.companyId` is reference data nothing decides on.
