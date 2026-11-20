import { Prisma, type PrismaClient } from '@prisma/client'
import { PAYMENTS_FEED, PAYMENT_FIELDS, type AcumaticaClient } from '@/lib/integrations/acumatica/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import {
  CLOSED_STATUS, collapseOtherPayments, mapOtherPayment, otherPaymentsFilter, type OtherPaymentRow,
} from '@/lib/integrations/acumatica/other-payments'
import { loadSettings } from '@/lib/settings/read'
import { OTHER_PAYMENTS_MODE } from '@/lib/sync/modes'
import { SyncInProgressError, type SyncTrigger } from '@/lib/sync/run'

/**
 * THE OTHER-PAYMENTS READ (2026-11-20): Acumatica's telegraphic transfers,
 * letters of credit, DP-at-sight payments and manager's checks, mirrored into
 * `OtherPayment`, one row per payment document (CV number) per tenant.
 *
 * Every run is the FULL in-scope set - about 1,700 rows, one request - so
 * there is no watermark and nothing can be skipped past. A `SyncRun` row of
 * mode `OTHER_PAYMENTS` is the trace; every other read ignores it
 * (lib/sync/modes.ts).
 *
 * It writes ONLY the Acumatica columns. `marking` is set once, when a payment
 * is first seen - PROCESSED when Acumatica already holds it Closed (released
 * and applied: the books say the money went), ON PROCESS otherwise - and never
 * again: the same rule as "an import never changes a check's status" (rule 4).
 * A payment that leaves the feed is left as it is; nothing is deleted.
 *
 * Never touches `Check`, never writes a PortalEvent, and reads Acumatica
 * through `fetchAll` only (rule 3). Reference data in, so no audit row per
 * payment; a marking Finance sets is audited by lib/payments/actions.ts.
 */

type Db = PrismaClient | Prisma.TransactionClient

export { OTHER_PAYMENTS_MODE }

const WRITE_BATCH = 500
const MAX_REPORTED_PROBLEMS = 5
const MAX_PROBLEM_LENGTH = 300

export type OtherPaymentsSyncArgs = {
  client: AcumaticaClient
  tenant: AcumaticaTenant
  now: Date
  trigger: SyncTrigger
  /** Read and count, write nothing - not even the SyncRun row. */
  dryRun?: boolean
}

export type OtherPaymentsRunResult = {
  syncRunId: string | null
  tenant: AcumaticaTenant
  /** Rows the feed returned. */
  fetched: number
  /** Rows that are not one of the four methods' payment documents. Not errors. */
  ignored: number
  /** Distinct payment documents read. */
  payments: number
  /** Payments first seen this run. */
  created: number
  /** Payments already held whose Acumatica columns changed. */
  updated: number
  /** Void reversals whose original the feed did not list. Dropped, counted. */
  orphanReversals: number
  errors: number
}

export async function runOtherPaymentsSync(db: Db, args: OtherPaymentsSyncArgs): Promise<OtherPaymentsRunResult> {
  const { client, tenant, now, trigger, dryRun = false } = args

  let runId: string | null = null
  if (!dryRun) {
    const inProgressMinutes = (await loadSettings(db)).values['sync.inProgressMinutes']
    // Only another OTHER_PAYMENTS run blocks this one; the other reads are other feeds.
    const open = await db.syncRun.findFirst({
      where: {
        tenant, mode: OTHER_PAYMENTS_MODE, finishedAt: null,
        startedAt: { gt: new Date(now.getTime() - inProgressMinutes * 60_000) },
      },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    })
    if (open) throw new SyncInProgressError(tenant, open.startedAt, inProgressMinutes)
    runId = (await db.syncRun.create({ data: { mode: OTHER_PAYMENTS_MODE, tenant, startedAt: now, trigger } })).id
  }

  let fetched = 0
  let ignored = 0
  let created = 0
  let updated = 0
  let orphanReversals = 0
  let errors = 0
  const problems: string[] = []

  const finish = async (): Promise<void> => {
    if (runId === null) return
    await db.syncRun.update({
      where: { id: runId },
      data: {
        finishedAt: new Date(), imported: created, updated, staged: orphanReversals, errors,
        message: problems.length > 0 ? summarise(problems) : null,
      },
    })
  }

  let rows: Awaited<ReturnType<AcumaticaClient['fetchAll']>>
  try {
    rows = await client.fetchAll(PAYMENTS_FEED, { select: PAYMENT_FIELDS, filter: otherPaymentsFilter() })
  } catch (error) {
    errors = 1
    problems.push(describe(error))
    await finish()
    throw error
  }
  fetched = rows.length

  const mapped: OtherPaymentRow[] = []
  for (const raw of rows) {
    const row = mapOtherPayment(raw, tenant)
    if (row === null) ignored++
    else mapped.push(row)
  }
  const collapsed = collapseOtherPayments(mapped)
  orphanReversals = collapsed.orphanReversals
  const payments = collapsed.payments

  if (!dryRun) {
    for (let i = 0; i < payments.length; i += WRITE_BATCH) {
      const batch = payments.slice(i, i + WRITE_BATCH)
      try {
        const wrote = await upsertBatch(db, batch)
        created += wrote.created
        updated += wrote.updated
      } catch (error) {
        errors++
        problems.push(`${batch[0].referenceNbr}…${batch[batch.length - 1].referenceNbr}: ${describe(error)}`)
      }
    }
    await finish()
  }

  return { syncRunId: runId, tenant, fetched, ignored, payments: payments.length, created, updated, orphanReversals, errors }
}

/**
 * One statement for up to WRITE_BATCH payments (rows travel as one JSON
 * parameter, as lib/sync/bill-refs.ts does). The insert sets `marking` from
 * Acumatica's status; the update list does not name `marking` or any column
 * Finance types, and its WHERE skips a payment whose Acumatica columns already
 * match, so a re-read of an unchanged set writes nothing. `xmax = 0` is true
 * for a row this statement inserted.
 */
async function upsertBatch(db: Db, batch: readonly OtherPaymentRow[]): Promise<{ created: number; updated: number }> {
  const payload = JSON.stringify(batch.map((p) => ({
    tenant: p.tenant, referenceNbr: p.referenceNbr, method: p.method, docType: p.docType,
    acumaticaStatus: p.acumaticaStatus, voided: p.voided,
    paymentDate: p.paymentDate?.toISOString() ?? null, paymentRef: p.paymentRef,
    // A string in, a numeric out: never a JS number (rule 8).
    amount: p.amount, currency: p.currency, vendorCode: p.vendorCode, payeeName: p.payeeName,
    description: p.description, cashAccount: p.cashAccount, branch: p.branch, companyCode: p.companyCode,
    lastModifiedOn: p.lastModifiedOn?.toISOString() ?? null,
  })))
  const written = await db.$queryRaw<{ inserted: boolean }[]>(Prisma.sql`
    INSERT INTO "OtherPayment" (
      "id", "tenant", "referenceNbr", "method", "docType", "acumaticaStatus", "voided", "paymentDate", "paymentRef",
      "amount", "currency", "vendorCode", "payeeName", "description", "cashAccount", "branch", "companyCode",
      "lastModifiedOn", "marking", "updatedAt")
    SELECT gen_random_uuid()::text, x."tenant", x."referenceNbr", x."method", x."docType", x."acumaticaStatus", x."voided",
           x."paymentDate", x."paymentRef", x."amount"::numeric(18,2), x."currency", x."vendorCode", x."payeeName",
           x."description", x."cashAccount", x."branch", x."companyCode", x."lastModifiedOn",
           (CASE WHEN x."acumaticaStatus" = ${CLOSED_STATUS} AND NOT x."voided" THEN 'PROCESSED' ELSE 'ON_PROCESS' END)::"PaymentMarking",
           (now() AT TIME ZONE 'UTC')
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS x("tenant" text, "referenceNbr" text, "method" text, "docType" text, "acumaticaStatus" text, "voided" boolean,
             "paymentDate" timestamp(3), "paymentRef" text, "amount" text, "currency" text, "vendorCode" text,
             "payeeName" text, "description" text, "cashAccount" text, "branch" text, "companyCode" text,
             "lastModifiedOn" timestamp(3))
    ON CONFLICT ("tenant", "referenceNbr") DO UPDATE
       SET "method" = EXCLUDED."method", "docType" = EXCLUDED."docType", "acumaticaStatus" = EXCLUDED."acumaticaStatus",
           "voided" = EXCLUDED."voided", "paymentDate" = EXCLUDED."paymentDate", "paymentRef" = EXCLUDED."paymentRef",
           "amount" = EXCLUDED."amount", "currency" = EXCLUDED."currency", "vendorCode" = EXCLUDED."vendorCode",
           "payeeName" = EXCLUDED."payeeName", "description" = EXCLUDED."description", "cashAccount" = EXCLUDED."cashAccount",
           "branch" = EXCLUDED."branch", "companyCode" = EXCLUDED."companyCode", "lastModifiedOn" = EXCLUDED."lastModifiedOn",
           "updatedAt" = EXCLUDED."updatedAt"
     WHERE ("OtherPayment"."method", "OtherPayment"."docType", "OtherPayment"."acumaticaStatus", "OtherPayment"."voided",
            "OtherPayment"."paymentDate", "OtherPayment"."paymentRef", "OtherPayment"."amount", "OtherPayment"."currency",
            "OtherPayment"."vendorCode", "OtherPayment"."payeeName", "OtherPayment"."description", "OtherPayment"."cashAccount",
            "OtherPayment"."branch", "OtherPayment"."companyCode", "OtherPayment"."lastModifiedOn")
           IS DISTINCT FROM
           (EXCLUDED."method", EXCLUDED."docType", EXCLUDED."acumaticaStatus", EXCLUDED."voided",
            EXCLUDED."paymentDate", EXCLUDED."paymentRef", EXCLUDED."amount", EXCLUDED."currency",
            EXCLUDED."vendorCode", EXCLUDED."payeeName", EXCLUDED."description", EXCLUDED."cashAccount",
            EXCLUDED."branch", EXCLUDED."companyCode", EXCLUDED."lastModifiedOn")
    RETURNING (xmax = 0) AS inserted`)
  const created = written.filter((w) => w.inserted).length
  return { created, updated: written.length - created }
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > MAX_PROBLEM_LENGTH ? `${text.slice(0, MAX_PROBLEM_LENGTH)}…` : text
}

function summarise(problems: readonly string[]): string {
  return [...new Set(problems)].slice(0, MAX_REPORTED_PROBLEMS).join(' | ')
}

// See lib/sync/scheduled.ts: an OData failure can be a whole HTML page.
const MAX_OUTCOME_MESSAGE = 300

export type ScheduledOtherPaymentsOutcome =
  | { tenant: AcumaticaTenant; outcome: 'RAN'; syncRunId: string | null; fetched: number; payments: number; created: number; updated: number; errors: number }
  | { tenant: AcumaticaTenant; outcome: 'IN_PROGRESS'; message: string }
  | { tenant: AcumaticaTenant; outcome: 'FAILED'; message: string }
  /** The cron left this read for the next run: too much of its time was spent. Not a failure. */
  | { tenant: AcumaticaTenant; outcome: 'SKIPPED_TIME_BUDGET' }

/**
 * One tenant's read, never throwing - for the cron and the screen's REFRESH
 * button. `client` is a factory so a missing environment variable is this
 * tenant's FAILED, not an exception before the other tenant has run.
 */
export async function runScheduledOtherPaymentsSync(
  db: Db,
  args: { tenant: AcumaticaTenant; now: Date; client: () => AcumaticaClient; trigger?: SyncTrigger },
): Promise<ScheduledOtherPaymentsOutcome> {
  const { tenant, now, trigger = 'SCHEDULED' } = args
  try {
    const r = await runOtherPaymentsSync(db, { client: args.client(), tenant, now, trigger })
    return { tenant, outcome: 'RAN', syncRunId: r.syncRunId, fetched: r.fetched, payments: r.payments, created: r.created, updated: r.updated, errors: r.errors }
  } catch (error) {
    if (error instanceof SyncInProgressError) {
      return { tenant, outcome: 'IN_PROGRESS', message: error.message.slice(0, MAX_OUTCOME_MESSAGE) }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { tenant, outcome: 'FAILED', message: message.slice(0, MAX_OUTCOME_MESSAGE) }
  }
}
