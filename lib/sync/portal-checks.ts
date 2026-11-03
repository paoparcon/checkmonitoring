import type { Prisma, PrismaClient } from '@prisma/client'
import { PORTAL_CHECK_BATCH, buildPortalCheckRow, type PortalCheckRow, type PortalCheckSource } from '@/lib/integrations/portal/check-feed'
import type { PortalCheckListClient } from '@/lib/integrations/portal/client'
import { createPortalClientFromEnv } from '@/lib/integrations/portal/from-env'
import { displayPoNumbers, loadAcumaticaPoIndex } from '@/lib/queries'
import { PORTAL_CHECKS_MODE } from '@/lib/sync/modes'
import type { SyncTrigger } from '@/lib/sync/run'

/**
 * THE CHECK LIST PUSH (spec 2026-11-03-check-list-in-portal-design). Every
 * cheque changed since the last push — whatever its status, cancelled and
 * voided included — is sent to the Supplier Portal in batches of
 * PORTAL_CHECK_BATCH, oldest change first, and the portal upserts them into
 * its `cm_check` table by this system's check id.
 *
 * Its watermark is `Check.updatedAt`, kept on `SyncRun` rows of
 * `mode = 'PORTAL_CHECKS'` (tenant null; every other reader ignores the mode,
 * lib/sync/modes.ts), read back with a 10-minute overlap: re-sending a row is
 * a no-op at the portal, missing one is not. Because the rows go out in
 * `updatedAt` order and the watermark is the last row sent, a run cut off by
 * its deadline or by a failed batch leaves the watermark where the next run
 * must continue — so a FULL push (every cheque, `since = null`) that does not
 * finish in one run is finished by the incremental runs after it. A run that
 * finds nothing to send writes no row at all; one that sends or fails writes
 * one, so /admin/portal can show the last push.
 *
 * Never status, never a PortalEvent, never an AuditLog row per cheque: this is
 * a mirror, not a record. Rule 12 holds — the client only sends.
 */

type Db = PrismaClient | Prisma.TransactionClient

export { PORTAL_CHECKS_MODE }

/** Read back from the watermark so a row written at the boundary is sent twice rather than never. */
export const PORTAL_CHECKS_OVERLAP_MINUTES = 10
const REQUEST_TIMEOUT_MS = 20_000
const MAX_MESSAGE = 300

/** The audit rows that record which AP bills a cancelled or voided cheque was cut loose from. */
const DETACH_ACTIONS = ['cancelled', 'voided', 'voided_after_release', 'apv_detached_on_cancel'] as const

export type PortalChecksPushArgs = {
  client: PortalCheckListClient
  now: Date
  trigger: SyncTrigger
  /** Stop before fetching another batch once this instant has passed; the watermark holds what was sent. */
  deadline?: Date
  /** Every cheque, not only those changed since the watermark. */
  full?: boolean
}

export type PortalChecksPushResult = {
  syncRunId: string | null
  /** Rows the portal accepted. */
  pushed: number
  batches: number
  errors: number
  stoppedAtDeadline: boolean
  /** Cheques still to send — after a deadline or a failed batch; the next run continues. */
  remaining: boolean
  message: string | null
}

export async function lastPortalChecksWatermark(db: Db): Promise<Date | null> {
  const run = await db.syncRun.findFirst({
    where: { mode: PORTAL_CHECKS_MODE, watermark: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { watermark: true },
  })
  return run?.watermark ?? null
}

export type PortalChecksLastRun = {
  startedAt: Date; finishedAt: Date | null; trigger: string; pushed: number; errors: number; message: string | null
}

/** The newest PORTAL_CHECKS run, for /admin/portal. */
export async function lastPortalChecksRun(db: Db): Promise<PortalChecksLastRun | null> {
  const run = await db.syncRun.findFirst({ where: { mode: PORTAL_CHECKS_MODE }, orderBy: { startedAt: 'desc' } })
  if (!run) return null
  return { startedAt: run.startedAt, finishedAt: run.finishedAt, trigger: run.trigger, pushed: run.imported, errors: run.errors, message: run.message }
}

const CHECK_INCLUDE = {
  company: { select: { code: true } },
  cashAccount: { select: { code: true, bank: { select: { code: true } } } },
  checkBook: { select: { code: true, bank: { select: { code: true } } } },
  releasedBy: { select: { name: true } },
  bills: { select: { apvNumber: true, poNumber: true } },
} satisfies Prisma.CheckInclude

type LoadedCheck = PortalCheckSource & { updatedAt: Date; id: string }

/** The rows of one batch: the detached APVs of its dead cheques and the PO numbers of every APV, looked up once each. */
export async function buildPortalCheckRows(db: Db, checks: LoadedCheck[]): Promise<PortalCheckRow[]> {
  const dead = checks.filter((c) => c.status === 'CANCELLED' || c.status === 'VOIDED')
  const detached = new Map<string, Set<string>>()
  if (dead.length) {
    const audits = await db.auditLog.findMany({
      where: { checkId: { in: dead.map((c) => c.id) }, action: { in: [...DETACH_ACTIONS] } },
      select: { checkId: true, details: true },
    })
    for (const a of audits) {
      const list = (a.details as { apvNumbersDetached?: unknown } | null)?.apvNumbersDetached
      if (!a.checkId || !Array.isArray(list)) continue
      const set = detached.get(a.checkId) ?? new Set<string>()
      for (const v of list) if (typeof v === 'string' && v) set.add(v)
      detached.set(a.checkId, set)
    }
  }
  const apvs = new Set<string>()
  for (const c of checks) { for (const a of c.apvNumbers) apvs.add(a); for (const b of c.bills) apvs.add(b.apvNumber) }
  const poIndex = await loadAcumaticaPoIndex(db, apvs)
  return checks.map((c) => buildPortalCheckRow(c, {
    detachedApvs: [...(detached.get(c.id) ?? [])],
    poNumbers: displayPoNumbers(c, poIndex),
  }))
}

export async function runPortalChecksPush(db: Db, args: PortalChecksPushArgs): Promise<PortalChecksPushResult> {
  const since = args.full ? null : await lastPortalChecksWatermark(db)
  const from = since ? new Date(since.getTime() - PORTAL_CHECKS_OVERLAP_MINUTES * 60_000) : null
  let cursor: { updatedAt: Date; id: string } | null = null
  let pushed = 0, batches = 0, errors = 0
  let stoppedAtDeadline = false, remaining = false
  let message: string | null = null
  let watermark: Date | null = null
  // A full push records itself at once with the epoch as its watermark, so a
  // first batch that fails still leaves the next run continuing the full push
  // rather than falling back to the old incremental watermark.
  let syncRunId: string | null = null
  if (args.full) {
    const run = await db.syncRun.create({
      data: { mode: PORTAL_CHECKS_MODE, tenant: null, trigger: args.trigger, startedAt: args.now, watermark: new Date(0), message: 'full push: every cheque, oldest change first' },
    })
    syncRunId = run.id
  }
  for (;;) {
    if (args.deadline && Date.now() >= args.deadline.getTime() && batches > 0) { stoppedAtDeadline = true; remaining = true; break }
    const checks: LoadedCheck[] = await db.check.findMany({
      where: {
        AND: [
          from ? { updatedAt: { gt: from } } : {},
          cursor ? { OR: [{ updatedAt: { gt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { gt: cursor.id } }] } : {},
        ],
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: PORTAL_CHECK_BATCH,
      include: CHECK_INCLUDE,
    })
    if (checks.length === 0) break
    const last = checks[checks.length - 1]
    try {
      const rows = await buildPortalCheckRows(db, checks)
      const res = await args.client.pushChecks(rows, { timeoutMs: REQUEST_TIMEOUT_MS })
      if (res.status !== 200) {
        errors = 1; remaining = true
        message = `the portal answered ${res.status}${res.error ? `: ${res.error}` : ''} on a batch of ${rows.length} (first ${checks[0].checkNumber})`.slice(0, MAX_MESSAGE)
        break
      }
      pushed += rows.length; batches += 1
      watermark = last.updatedAt
      cursor = { updatedAt: last.updatedAt, id: last.id }
    } catch (e) {
      errors = 1; remaining = true
      message = `batch of ${checks.length} (first ${checks[0].checkNumber}) failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, MAX_MESSAGE)
      break
    }
    if (checks.length < PORTAL_CHECK_BATCH) break
  }
  if (!message && stoppedAtDeadline) message = `stopped at the deadline after ${pushed} cheque(s); the next push continues`
  if (pushed === 0 && errors === 0 && !syncRunId) return { syncRunId: null, pushed, batches, errors, stoppedAtDeadline, remaining, message }
  const data = {
    finishedAt: new Date(), imported: pushed, errors, message,
    // A full push's epoch watermark stands until a batch is sent.
    ...(watermark ? { watermark } : {}),
  }
  if (syncRunId) {
    await db.syncRun.update({ where: { id: syncRunId }, data })
  } else {
    const run = await db.syncRun.create({ data: { mode: PORTAL_CHECKS_MODE, tenant: null, trigger: args.trigger, startedAt: args.now, ...data } })
    syncRunId = run.id
  }
  return { syncRunId, pushed, batches, errors, stoppedAtDeadline, remaining, message }
}

/**
 * Best-effort, within a budget, never throws: from the delivery kick, the
 * admin button and the cron. `{ skipped }` names the missing setting when the
 * portal is not configured, and the client's fake in a test that implements
 * `deliver` alone skips too.
 */
export async function pushChecksToPortal(
  db: Db,
  args: { budgetMs: number; client?: Partial<PortalCheckListClient>; now?: Date; trigger?: SyncTrigger; full?: boolean },
): Promise<PortalChecksPushResult | { skipped: string }> {
  const now = args.now ?? new Date()
  let client: Partial<PortalCheckListClient>
  if (args.client) {
    client = args.client
  } else {
    try { client = createPortalClientFromEnv() }
    catch (e) { return { skipped: (e instanceof Error ? e.message : String(e)).split(',')[0] } }
  }
  const pushChecks = client.pushChecks
  if (!pushChecks) return { skipped: 'the portal client cannot push the check list' }
  try {
    return await runPortalChecksPush(db, {
      client: { pushChecks: pushChecks.bind(client) }, now, trigger: args.trigger ?? 'MANUAL', full: args.full,
      deadline: new Date(now.getTime() + args.budgetMs),
    })
  } catch (e) {
    console.error('check list push failed:', e instanceof Error ? e.message : e)
    return { syncRunId: null, pushed: 0, batches: 0, errors: 1, stoppedAtDeadline: false, remaining: true, message: e instanceof Error ? e.message : String(e) }
  }
}
