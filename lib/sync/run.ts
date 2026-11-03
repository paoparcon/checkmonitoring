import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from '@/lib/domain/errors'
import { upsertCheck } from '@/lib/import/upsert'
import {
  PAYMENTS_FEED,
  PAYMENT_FIELDS,
  type AcumaticaClient,
  type AcumaticaRow,
} from '@/lib/integrations/acumatica/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import { collapseVoidPairs, mapPayment } from '@/lib/integrations/acumatica/map'
import type { NormalisedRow } from '@/lib/normalised-row'
import { DEFAULT_SYNC_IN_PROGRESS_MINUTES } from '@/lib/settings/defaults'
import { NON_PAYMENT_MODES } from '@/lib/sync/modes'

type Db = PrismaClient | Prisma.TransactionClient

// The same shape `lib/import/upsert.ts` uses, for the one place here that must
// write two rows or neither.
async function inTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ('$transaction' in db && typeof db.$transaction === 'function') {
    return (db as PrismaClient).$transaction(fn)
  }
  return fn(db as Prisma.TransactionClient)
}

/**
 * How far back of the feed's own modification timeline every incremental run
 * re-reads.
 *
 * A row committed *during* a run can carry a `LastModifiedOn` below the maximum
 * that run observed: Acumatica stamps the row when the transaction starts, the
 * feed only shows it once it commits, and the two are not the same instant. A
 * watermark set to the bare maximum would step straight over such a row and it
 * would never be picked up again — a payment silently absent from a cheque
 * register, which is the one failure this system exists to prevent.
 *
 * 120 minutes comes from the Supplier Portal's integration against this same
 * instance; it is that system's measured setting, not a guess. Re-reading two
 * hours costs nothing, because every row goes through `upsertCheck`, which
 * updates rather than duplicates. Do not "optimise" this to zero.
 */
export const SYNC_OVERLAP_MINUTES = 120

/**
 * How long an unfinished run is believed to be still running.
 *
 * `runSync` writes its row before reading the feed and finishes it in every
 * exit path it controls — but a platform kill runs no `catch`, so a killed run
 * keeps `finishedAt` null for ever. The 4 September 14:07 row in production is
 * one. Two facts follow: a null `finishedAt` inside this window is a run to
 * wait for, and one outside it is a corpse to ignore.
 *
 * Ten minutes is generous against the 60-second function limit the scheduled
 * route runs under, and short enough that a killed SYNC NOW does not lock the
 * tenant until somebody notices. `ABANDONED_AFTER_MINUTES` in
 * lib/admin/sync-overview.ts is the SCREEN's threshold for the same rows and is
 * deliberately longer: a terminal run of a first full sync legitimately takes
 * an hour, and the screen must not libel it. This one governs whether a NEW
 * run may start, and nothing that runs on a schedule takes an hour.
 */
export const SYNC_IN_PROGRESS_MINUTES = DEFAULT_SYNC_IN_PROGRESS_MINUTES

/**
 * Thrown before anything is written. A `DomainError`, so the admin action shows
 * its message rather than a stack trace, and the scheduled route can tell it
 * from a failure — a sync that declined to double up is not a sync that broke.
 */
export class SyncInProgressError extends DomainError {
  constructor(tenant: AcumaticaTenant, startedAt: Date, minutes: number) {
    super(
      'SYNC_IN_PROGRESS',
      `A ${tenant} sync started at ${startedAt.toISOString()} has not finished. ` +
        `Wait for it, or ${minutes} minutes, before starting another.`,
    )
  }
}

async function assertNoRunInProgress(
  db: Db,
  tenant: AcumaticaTenant,
  now: Date,
  inProgressMinutes: number,
): Promise<void> {
  const open = await db.syncRun.findFirst({
    where: {
      tenant,
      // BILLS and BILL_REFS rows are other feeds' reads (lib/sync/modes.ts), with their own watermarks.
      mode: { notIn: [...NON_PAYMENT_MODES] },
      finishedAt: null,
      startedAt: { gt: new Date(now.getTime() - inProgressMinutes * 60_000) },
    },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  })
  if (open) throw new SyncInProgressError(tenant, open.startedAt, inProgressMinutes)
}

/**
 * Only the bounded head of the problem list reaches `SyncRun.message`. The AP
 * feed runs to roughly 37,000 rows; if a schema change broke every one of them,
 * 37,000 sentences in a text column is not a diagnosis, it is a denial of
 * service on the admin page. Distinct messages, capped, with the rest counted.
 */
const MAX_REPORTED_PROBLEMS = 5
const MAX_PROBLEM_LENGTH = 300

export type SyncMode = 'FULL' | 'INCREMENTAL'

/** Who started a run. Stated by every caller, never defaulted — like `tenant`. */
export type SyncTrigger = 'MANUAL' | 'SCHEDULED'

export type SyncArgs = {
  client: AcumaticaClient
  /**
   * Explicit, never inferred and never defaulted. The two tenants reuse branch
   * codes for different companies — Go-Live `ST` is Starkson Packaging,
   * MANUFACTURING `ST` is Starkson Paper and Plastic — so a run that guessed
   * would file cheques under the wrong legal entity while looking correct.
   */
  tenant: AcumaticaTenant
  /** The previous run's watermark, or null for a full read. See `lastSyncWatermark`. */
  since: Date | null
  now: Date
  /**
   * A person pressing SYNC NOW, a terminal run, or the schedule. Recorded on
   * the `SyncRun` row so the admin log can say which runs happened because
   * somebody remembered and which because nobody had to.
   */
  trigger: SyncTrigger
  /** Settings `sync.inProgressMinutes`; the constant when a caller passes nothing. */
  inProgressMinutes?: number
}

export type SyncRunResult = {
  syncRunId: string
  tenant: AcumaticaTenant
  mode: SyncMode
  /** Rows the feed returned. */
  fetched: number
  /** Rows `mapPayment` declined: Prepayment, Debit Adj., Refund. Not errors. */
  skipped: number
  /**
   * Reversal rows folded into the original of a voided pair by
   * `collapseVoidPairs`. Counted rather than left implicit so that
   * `fetched === skipped + collapsed + imported + updated + staged + errors`
   * still holds — the invariant that makes "nothing is silently dropped"
   * checkable rather than asserted.
   */
  collapsed: number
  imported: number
  updated: number
  /**
   * Payments kept whole because they could not be written: since 2026-09-04 an
   * Acumatica row CAN be staged, and 80 live cheques carrying a memo instead of
   * a cheque number land here every run. They were previously counted as
   * errors, which is why the count is reported and recorded rather than left to
   * be inferred from a shortfall.
   */
  staged: number
  errors: number
  /** Staged register rows this run linked to a cheque. */
  promoted: number
  /**
   * Where the next incremental run should start. Null when this run took
   * responsibility for no rows, which leaves the previous watermark standing.
   */
  watermark: Date | null
}

/**
 * The scope boundary, and the reason a sync is now a job a web request can
 * finish.
 *
 * Finance ruling, 2026-09-04: this is a cheque monitoring system for current
 * work, not an AP ledger and not an archive. A full sync without these filters
 * reads 41,998 rows and creates a cheque for every AP payment Acumatica has
 * ever held — it did exactly that, importing 12,530 pre-2026 records that were
 * never in the register before the run was killed. Those were removed by
 * `scripts/trim-out-of-scope.ts`; these filters are what stop them walking back
 * in on the next sync.
 *
 * Measured against the live feed:
 *
 *     no filter              41,998 rows   21s
 *     PaymentDate >= 2026    15,542 rows    7s
 *     2026 + CHK             11,417 rows    5s   (CHK or CASH since 2026-10-23)
 *
 * The reduction is what makes SYNC NOW usable at all — a serverless request
 * cannot finish 42,000 rows and Vercel kills it partway.
 *
 * Keep this date in step with `IN_SCOPE_FROM` in `scripts/trim-out-of-scope.ts`.
 * They are the same decision expressed twice: one trims what is there, the
 * other refuses what would arrive.
 */
export const SYNC_FROM_DATE = '2026-01-01T00:00:00'

/**
 * The payment-method clause is applied by the FEED, not after mapping, so
 * non-checks are never fetched. `mapPayment` still computes `isCheque` from
 * the same field plus the China-branch rule — that second check is not
 * redundant, it is what protects a row arriving by any other path.
 *
 * `CHK` only until 2026-10-23; `CASH` since, on the user's ruling that every
 * AP voucher is paid by a physical check and CASH means one payable to cash
 * (see `CHEQUE_PAYMENT_METHODS` in `integrations/acumatica/map.ts`). The two
 * must agree: a method the feed fetches that the map calls a non-check would
 * import as money with no SIGN button, and one the map accepts that the feed
 * never asks for is the 2026-10-19 defect — a check absent from the portal.
 * Measured read-only the same day: the `AP-Checks and Payments` inquiry
 * accepts this parenthesised `or` (943 rows = 942 CHK + 1 CASH for October),
 * unlike the bills inquiry, where an `or` of `eq` filters is a 500.
 */
const CHEQUES_ONLY = "(PaymentMethod eq 'CHK' or PaymentMethod eq 'CASH')"
const IN_SCOPE = `PaymentDate ge datetime'${SYNC_FROM_DATE}'`

/**
 * Only the OData v3 `datetime'...'` literal works against this instance,
 * measured read-only on 2026-09-04: a bare `2026-09-03T20:00:00`, the same with
 * a trailing `Z`, and `datetimeoffset'…'` each returned **HTTP 500**. A 2099
 * cutoff returned zero rows, so the filter genuinely excludes rather than being
 * quietly ignored.
 *
 * `toISOString().slice(0, 19)` reproduces exactly the naive string the feed
 * sent, which is what `map.ts` pins the `Z` suffix for. Do not add a zone: the
 * feed's timestamps carry none and appending one is a 500.
 */
export function paymentsSinceFilter(since: Date): string {
  return `LastModifiedOn ge datetime'${since.toISOString().slice(0, 19)}' and ${IN_SCOPE} and ${CHEQUES_ONLY}`
}

/** The filter for a full run: in-scope cheques, with no watermark. */
export function paymentsInScopeFilter(): string {
  return `${IN_SCOPE} and ${CHEQUES_ONLY}`
}

/**
 * The watermark the last run for this tenant left. Per tenant, because the two
 * are separate feeds on separate base URLs whose progress has nothing to do
 * with each other — a single shared watermark would let a Go-Live run advance
 * MANUFACTURING past rows nobody had read.
 */
export async function lastSyncWatermark(db: Db, tenant: AcumaticaTenant): Promise<Date | null> {
  const run = await db.syncRun.findFirst({
    // Rows of NON_PAYMENT_MODES (lib/sync/modes.ts: BILLS, BILL_REFS) are other feeds' reads; their watermarks are on different feeds.
    where: { tenant, mode: { notIn: [...NON_PAYMENT_MODES] }, watermark: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { watermark: true },
  })
  return run?.watermark ?? null
}

/**
 * One incremental read of one Acumatica tenant, through the one write path.
 *
 * Everything goes through `upsertCheck`. Duplicate prevention lives there and
 * nowhere else — this function does no matching of its own, so the sync and the
 * workbook importer can never end up disagreeing about what counts as the same
 * cheque.
 *
 * Writes no `PortalEvent`, ever. A sync changes a cheque's *data*; telling a
 * supplier that money is waiting is a Finance action. `tests/sync/run.test.ts`
 * asserts the count is unchanged after every single test in the file.
 */
export async function runSync(db: Db, args: SyncArgs): Promise<SyncRunResult> {
  const { client, tenant, since, now, trigger } = args
  const inProgressMinutes = args.inProgressMinutes ?? SYNC_IN_PROGRESS_MINUTES
  const mode: SyncMode = since ? 'INCREMENTAL' : 'FULL'

  // Before the row, so a refused start leaves no trace of its own. The check
  // and the create are two round trips, not one transaction — a genuine race
  // between two clicks a millisecond apart would let both through, and the
  // upserts are idempotent so the cost of that is wasted work, not a wrong
  // cheque. What this stops is the common case: a cron landing on a SYNC NOW.
  await assertNoRunInProgress(db, tenant, now, inProgressMinutes)

  // Written BEFORE the feed is read, and finished in every exit path below. A
  // run with `finishedAt` null is therefore one that is still going or whose
  // process died — which is what makes a hung sync distinguishable from a
  // failed one on the admin screen.
  const run = await db.syncRun.create({ data: { mode, tenant, startedAt: now, trigger } })

  let fetched = 0
  let skipped = 0
  let collapsed = 0
  let imported = 0
  let updated = 0
  let staged = 0
  let errors = 0
  let promoted = 0
  const problems: string[] = []

  const finish = async (watermark: Date | null): Promise<void> => {
    await db.syncRun.update({
      where: { id: run.id },
      data: {
        // The real instant, not `now`. `now` is the caller's clock and is what
        // `startedAt` holds; writing it here too gave every run in production a
        // duration of zero (measured 2026-09-10) and made a hung run look
        // finished the moment it began.
        finishedAt: new Date(),
        imported,
        updated,
        staged,
        errors,
        watermark,
        message: problems.length ? summarise(problems, errors) : null,
      },
    })
  }

  let rows: AcumaticaRow[]
  try {
    rows = await client.fetchAll(PAYMENTS_FEED, {
      select: PAYMENT_FIELDS,
      // A full run is filtered too: without it the feed returns 41,998 rows and
      // imports AP history that was never in the register. See SYNC_FROM_DATE.
      filter: since ? paymentsSinceFilter(since) : paymentsInScopeFilter(),
      // Not cosmetic. `fetchAll` pages with `$skip`, and `$skip` over an
      // unordered result set is not stable: rows can shift between pages and be
      // read twice (harmless, the upsert absorbs it) or skipped entirely (a
      // payment silently missing). Measured against the live instance on
      // 2026-09-04: an ordered 2,000-row page came back in 847ms versus 989ms
      // unordered, so the guarantee is free.
      orderby: 'LastModifiedOn asc',
    })
  } catch (error) {
    // The feed is unreachable, unauthorised, or answering with an error page.
    // Nothing was read, so the watermark must not move — advancing it here
    // would step over every row this run failed to see.
    errors = 1
    problems.push(describe(error))
    await finish(null)
    throw error
  }

  fetched = rows.length

  // `classifyEligibility` needs the client's own legal names to tell an
  // inter-company cheque from a supplier one. Read once per run rather than per
  // row: it is reference data, and 37,000 identical queries is not free.
  const ownCompanyNames = (await db.company.findMany({ select: { legalNames: true } }))
    .flatMap((c) => c.legalNames)

  let maxSeen: Date | null = null

  const mapped: NormalisedRow[] = []
  for (const raw of rows) {
    // Null is "not our business" — a Prepayment, Debit Adj. or Refund — not an
    // error. 80 of 400 live rows were Debit Adj.; counting those as failures
    // would make a healthy sync look broken.
    const row = mapPayment(raw, tenant)
    if (row === null) {
      skipped++
      continue
    }

    // The maximum over rows this run took responsibility for, which deliberately
    // excludes the document types above: advancing past a Debit Adj. we never
    // import could carry the watermark over a Payment committed just behind it.
    // Conservative in the only direction that is safe — re-reading costs a
    // no-op update, missing a row costs a cheque.
    //
    // Taken BEFORE the collapse below, over every row the feed returned. The
    // reversal half of a voided pair is a row we did read, and leaving its
    // timestamp out would hold the watermark back and re-read it forever.
    if (row.lastModifiedOn && (maxSeen === null || row.lastModifiedOn > maxSeen)) {
      maxSeen = row.lastModifiedOn
    }

    mapped.push(row)
  }

  // A void is two rows under one PaymentRef, both carrying an IDENTICAL
  // LastModifiedOn, so there is nothing for a last-write-wins upsert to order
  // them by and a cheque could store its own negative reversal as its amount.
  // Collapsed here, before anything is written — the way `groupByCheckNumber`
  // collapses the register's ambiguity groups before any row of one is written.
  // This is not a second duplicate-prevention path: prevention remains solely
  // the unique key inside `upsertCheck`, and must stay there.
  const toWrite = collapseVoidPairs(mapped)
  collapsed = mapped.length - toWrite.length

  for (const row of toWrite) {
    try {
      const result = await upsertCheck(db, { row, ownCompanyNames, now })

      if (result.outcome === 'STAGED') {
        // Reachable since 2026-09-04: an Acumatica row is keyed on its own
        // ReferenceNbr, so a payment that cannot become a `Check` — 80 live
        // cheques carrying a memo where the number belongs — is kept whole
        // instead of thrown away as an error. It still needs a human, which is
        // what the recorded count is for.
        staged++
        continue
      }

      if (result.outcome === 'CREATED') imported++
      else updated++

      promoted += await promoteStagedRows(db, {
        checkId: result.checkId,
        checkNumber: row.checkNumber,
        companyCode: row.companyCode,
      })
    } catch (error) {
      // One bad row must not cost a 37,000-row sync. The row is counted, its
      // problem recorded on the run, and the loop carries on — an abort here
      // would discard every row after the first surprise in the feed.
      errors++
      problems.push(describe(error))
    }
  }

  // THE 120-MINUTE OVERLAP. The maximum seen is the wrong answer on its own;
  // see SYNC_OVERLAP_MINUTES for why. Null stays null so the previous run's
  // watermark stands rather than being reset to two hours before nothing.
  const watermark =
    maxSeen === null ? null : new Date(maxSeen.getTime() - SYNC_OVERLAP_MINUTES * 60_000)

  await finish(watermark)

  return {
    syncRunId: run.id, tenant, mode,
    fetched, skipped, collapsed, imported, updated, staged, errors, promoted, watermark,
  }
}

/**
 * Links the register rows that were staged for want of a company to the cheque
 * the sync has just resolved one for.
 *
 * **The match is `(companyCode, checkNumber)`, never the cheque number alone.**
 * A cheque number is unique only per company, so `findFirst({ checkNumber })`
 * would happily link the register's evidence to a sibling company's cheque of
 * the same number. `checkId` here is not a number lookup: it is what
 * `upsertCheck` resolved through the `(companyId, checkNumber)` unique key,
 * with the company coming from Acumatica's own `Branch`. That is the whole
 * reason Task 7 left `promotedCheckId` unwritten and this is where it becomes
 * safe. Do not replace this with a lookup by number.
 *
 * Only `NO_COMPANY` rows. **`AMBIGUOUS_COMPANY` rows are deliberately left
 * alone** — 61 rows across 27 cheque numbers, of which 25 are one physical
 * cheque entered twice, which Finance ruled on 2026-09-03 must each be settled
 * by a human. Acumatica supplying a company says which company the cheque
 * belongs to; it does not say which of two contradicting register rows was the
 * right one, and promoting one of them would resolve by accident the exact
 * question Finance asked to decide. `NO_CHECK_NUMBER` rows carry no number to
 * match at all.
 *
 * The staged row is linked, never deleted: it is the evidence of why the cheque
 * was held, and deleting it destroys the only record of that.
 *
 * Idempotent by the `promotedCheckId: null` filter, so a re-read of the same
 * payment on the next run promotes nothing and writes no second audit row.
 */
async function promoteStagedRows(
  db: Db,
  args: { checkId: string; checkNumber: string | null; companyCode: string | null },
): Promise<number> {
  const { checkId, checkNumber, companyCode } = args
  // Both are non-null for any row that reached a written check, but stated
  // rather than asserted: a null here must promote nothing, not everything.
  if (checkNumber === null || companyCode === null) return 0

  const staged = await db.stagedCheck.findMany({
    where: { reason: 'NO_COMPANY', checkNumber, promotedCheckId: null },
    select: { id: true, source: true, sourceSheet: true, sourceRow: true, acumaticaRef: true },
  })
  if (staged.length === 0) return 0

  for (const s of staged) {
    // A staged row is no longer necessarily a register row, so the audit says
    // which one it is rather than calling every one of them a register row.
    const where = s.source === 'WORKBOOK'
      ? `Register row ${s.sourceSheet} ${s.sourceRow}`
      : `Acumatica payment ${s.acumaticaRef}`

    await inTx(db, async (tx) => {
      await tx.stagedCheck.update({ where: { id: s.id }, data: { promotedCheckId: checkId } })
      await writeAudit(tx, {
        checkId,
        actorType: 'SYSTEM',
        action: 'staged_row_promoted',
        details: {
          stagedCheckId: s.id,
          source: s.source,
          sourceSheet: s.sourceSheet,
          sourceRow: s.sourceRow,
          acumaticaRef: s.acumaticaRef,
          reason: 'NO_COMPANY',
          checkNumber,
          companyCode,
        },
        remarks:
          `${where} was staged because nothing said which company check ${checkNumber} ` +
          `belonged to. Acumatica states ${companyCode}, so it is linked to this check. ` +
          'The staged row is kept as the record of why it was held.',
      })
    })
  }
  return staged.length
}

/**
 * A message safe to store on a `SyncRun` and paste into a ticket. Truncated
 * because a driver-level failure can carry a very long payload, and this column
 * is read by a human, not a parser.
 */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > MAX_PROBLEM_LENGTH ? `${text.slice(0, MAX_PROBLEM_LENGTH)}…` : text
}

function summarise(problems: readonly string[], errors: number): string {
  const distinct = [...new Set(problems)]
  const shown = distinct.slice(0, MAX_REPORTED_PROBLEMS)
  const rest = distinct.length - shown.length
  return (
    `${errors} row(s) failed. ` +
    shown.join(' | ') +
    (rest > 0 ? ` | and ${rest} further distinct problem(s)` : '')
  )
}
