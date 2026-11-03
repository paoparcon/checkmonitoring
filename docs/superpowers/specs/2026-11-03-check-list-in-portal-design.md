# The check list in the Supplier Portal

**Date:** 2026-11-03 · **Status:** built, awaiting deploy (portal migration 096 + both deploys)
**Repos:** Check Monitoring (the feed) and Supplier Portal (`cm_check`, the endpoint, the page).
This file is kept identical in both repositories.

## The ask

User, 2026-11-03: *"make sure all the checks including cancelled, void from the system are in
the portal."* Asked whether to send cancellations only for bills no live check pays, or to build
a full check list in the portal, the user chose **"Full check list"**.

## Why the existing integration cannot answer it

The portal keeps **one release row per AP BILL**, keyed by APV (`check_release`, `resolveRefs` in
`src/checks/match.js`); Check Monitoring keeps **events per CHECK**. Since the 2026-10-29 ruling a
cancelled or voided check is detached from its bills and no CANCELLED is sent at all, because a
void and re-issue is two checks on one bill and the old check's CANCELLED cancels the replacement's
row (`6000354974`..`77`). Measured 2026-11-03 before this build:

- 62 checks voided since September, all detached; 52 of them have a live replacement on the same
  bill, so a CANCELLED for them would hit the replacement's row; 54 were never told to the portal
  and were never READY or RELEASED here.
- 11 RELEASED checks the portal was never told about (`1791363573 1791379615 1791379616 1791405441
  1791405471 6000338817 6000349425 6000353624 6000353695 6000353743 6000353877`): no `releasedAt`,
  seven with no release date at all, four with register dates before 1 September and earlier than
  the check date. They need Finance's real release day; the release-row path cannot carry them.
- 0 parked events.

A per-bill row can never show "this check was voided" without touching the bill's live state. So
the portal gets a second, independent table: **every check, as Check Monitoring holds it**, a
mirror and not a record.

## Design

### Check Monitoring: the feed (`lib/integrations/portal/check-feed.ts`, `lib/sync/portal-checks.ts`)

- `buildPortalCheckRow` (pure) turns a check into the portal row: id, check number, CV, company,
  bank (cash account's bank, else check book's bank), check book, cash account label, payee,
  amount as a 2-decimal string or null (rule 8), currency, check date, `isCheque`, status,
  eligibility, `isStale`, live APVs, **detached APVs** (read from the `cancelled` / `voided` /
  `voided_after_release` / `apv_detached_on_cancel` audit rows, so a dead check still names the
  bills it paid), PO numbers (`displayPoNumbers`, the one definition), Acumatica status and
  tenant, signed / ready / released instants, pickup date, release date (`releasedAt`, else the
  register's `statedReleaseDate`, as a Manila day), who released, OR/CR, cancelled / voided
  instants and the cancel reason, `updatedAt`.
- `runPortalChecksPush` pages the tenant-agnostic `Check` table by `(updatedAt, id)` from a
  **watermark** (`SyncRun.mode = 'PORTAL_CHECKS'`, overlap 10 minutes), 500 rows a batch
  (`PORTAL_CHECK_BATCH`), and PUTs each batch to the portal. The watermark advances to the last
  batch sent; a non-200 or a throw holds it there (`errors = 1`, `remaining = true`), a deadline
  stops it between batches. A quiet incremental run writes no `SyncRun` row. `--full` creates
  the run first with an epoch watermark, so an interrupted full push resumes where it stopped.
- `pushChecksToPortal` never throws and reports `{ skipped }` when `PORTAL_BASE_URL` is unset.
- **Every portal kick pushes the list after the outbox** (`kickPortalDelivery`): an action's
  8 s, the cron, Deliver now's 25 s — the push takes whatever budget is left and is skipped under
  2 s (`CHECK_LIST_MIN_MS`). So a status change reaches the portal twice: as the per-bill event it
  already sent, and as the check's row.
- `/admin/portal` shows SUPPLIER PORTAL · CHECK LIST (last push, how many checks are behind the
  watermark, the total) and SEND EVERY CHECK (`pushEveryCheckAction`, FINANCE_ADMIN, full, 50 s).
  `scripts/push-checks-to-portal.ts [--full] [--dry-run]` is the terminal form; it prints counts
  and check numbers, never amounts.
- The client (`client.ts`) gains `pushChecks`: `PUT /api/integrations/check-monitoring/checks`,
  same bearer, body `{ checks: rows }`. It still only sends (rule 12: two send-only methods now).
- Rule 2 holds: an INTERNAL check is in the list, flagged `eligibility: 'INTERNAL'`, and the list
  is admin-only in the portal — no payee ever reads it.

### Supplier Portal: the mirror

- Migration `096_cm_check.sql`: `cm_check`, primary key `cm_id` (Check Monitoring's check id),
  one column per feed field, `cm_updated_at` and `received_at`; indexes on status and number.
- `PUT /api/integrations/check-monitoring/checks` (`src/integrations/check-monitoring-checks.js`):
  `requireServiceToken` with the same `CHECK_MONITORING_TOKEN` and `check-monitoring` user; the
  6 MB parser the events route uses; `validateBatch` (≤ 500 rows, status and eligibility enums,
  two-decimal amount or null, real `YYYY-MM-DD` dates, ISO instants, lists joined with `, `) →
  400 `{ error }`; `upsertChecks` dedupes by id keeping the newest `cm_updated_at`, **skips a row
  not newer than the one held** (so a retry or an out-of-order batch never rolls a check back),
  writes in one transaction through `upsertMany`; one audit row per batch
  (`check_monitoring_checks_upsert`, entity `cm_check`, the counts and never the rows); answers
  `{ received, upserted, inserted, updated, skippedOlder }`.
- `GET /api/cm-checks`: cookie session + `adminOnly` (every admin tier; a supplier or broker is
  403; the service bearer is no login here). `q` (number, payee, CV, live or detached APV, PO),
  `status`, `page`, `pageSize` ≤ 200; `counts` per status over the whole table; order check date
  desc, number desc.
- **All Checks** (`#cmChecks`, `public/js/cm-checks.js`, Payments group after Released Checks,
  denied to `viewerOnly` like Released Checks): status tabs with counts, search, server paging,
  a `no-tablekit` table — check no. (with *internal* / *not a cheque* tags), bank and book,
  company, payee, amount (or *no amount*), check date, status chip (STALED where Check Monitoring
  says so), status date (release day and who released; cancel day and reason; void day; pickup
  or ready day; signed day), AP bills (live, and *was …* for detached), PO, CV, Acumatica status,
  OR/CR. Cancelled and voided rows are dimmed, never hidden. Dates go through `dateCore.fmtDate`.
  The page changes nothing: there is no action on it.

## What it does not do

- It does not touch `check_release`. Release rows, pickups, receipts and the per-bill events are
  unchanged; the 2026-10-29 re-issue rule stands.
- It does not send anything back (the portal still sends Check Monitoring nothing).
- It does not delete: a check deleted in Check Monitoring (`deleteIncompleteCheck`) stays in
  `cm_check` until a push with that id arrives, which never happens. Measured scope: ≤ 98
  incomplete checks qualify for deletion; acceptable, and the row says what it was.
- It does not fix the 11 released checks' dates: they arrive with whatever release date Check
  Monitoring holds (register day or none). Finance supplies the real day.

## Go-live, in order

1. Portal: `npm run migrate` (096), then `vercel --prod` from the portal folder.
2. Check Monitoring: merge, `npx vercel --prod` from a master-merged tree (no migration).
3. First load: SEND EVERY CHECK on `/admin/portal`, or `npx tsx scripts/push-checks-to-portal.ts
   --full` from a terminal (about 13,000 checks, 27 batches; resumable). From then on every kick
   and cron run keeps the list current.
