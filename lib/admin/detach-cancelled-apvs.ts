import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { detachFromBills, APV_DETACHED_ACTION, DETACHED_SKIP_REASON } from '@/lib/domain/actions'

type Db = PrismaClient | Prisma.TransactionClient

/** Each row is several round trips to ap-southeast-1; Prisma's 5s default would kill the run. */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const

/** The statuses a cheque is detached at (user ruling 2026-10-29). */
export const DETACHED_STATUSES = ['CANCELLED', 'VOIDED'] as const

/**
 * `lastError` on a CANCELLED event this repair closes unsent. The `unmatchable:`
 * prefix is what `/admin/portal` counts (lib/admin/portal-overview.ts), and it
 * is the truth: with no APV left on the cheque the portal could never match it.
 */
export const DETACHED_EVENT_ERROR = `unmatchable: ${DETACHED_SKIP_REASON}`

export type AttachedCancelledRow = {
  checkId: string
  checkNumber: string
  status: (typeof DETACHED_STATUSES)[number]
  apvNumbers: string[]
  billApvs: string[]
  /** CANCELLED events still open (PENDING, FAILED or PARKED); closed unsent by the repair. */
  openEventIds: string[]
}

/**
 * Every CANCELLED or VOIDED cheque still connected to an AP bill — through
 * `apvNumbers` or a `CheckBill` row — cancelled before the 2026-10-29 rule
 * that a cancellation detaches the cheque (`detachFromBills`,
 * lib/domain/actions.ts). Prints no amounts.
 */
export async function findAttachedCancelled(db: Db): Promise<AttachedCancelledRow[]> {
  const rows = await db.check.findMany({
    where: {
      status: { in: [...DETACHED_STATUSES] },
      OR: [{ apvNumbers: { isEmpty: false } }, { bills: { some: {} } }],
    },
    orderBy: [{ status: 'asc' }, { checkNumber: 'asc' }, { id: 'asc' }],
    select: {
      id: true, checkNumber: true, status: true, apvNumbers: true,
      bills: { select: { apvNumber: true }, orderBy: { apvNumber: 'asc' } },
      portalEvents: { where: { kind: 'CANCELLED', status: { in: ['PENDING', 'FAILED', 'PARKED'] } }, select: { id: true } },
    },
  })
  return rows.map((r) => ({
    checkId: r.id, checkNumber: r.checkNumber,
    status: r.status as (typeof DETACHED_STATUSES)[number],
    apvNumbers: r.apvNumbers, billApvs: r.bills.map((b) => b.apvNumber),
    openEventIds: r.portalEvents.map((e) => e.id),
  }))
}

/**
 * Detach each cheque — the same `detachFromBills` a cancel runs today — close
 * its open CANCELLED events unsent (SYNCED with `DETACHED_EVENT_ERROR`, the
 * worker's own convention for a row closed without a request), set
 * `portalSyncStatus` to NOT_APPLICABLE, and write one `apv_detached_on_cancel`
 * audit row carrying what was detached, in one transaction per cheque.
 * Conditional: a cheque no longer CANCELLED or VOIDED when its turn comes is
 * left alone. Returns how many cheques were detached and events closed.
 */
export async function detachAttachedCancelled(
  db: PrismaClient, rows: readonly AttachedCancelledRow[], now: Date,
): Promise<{ detached: number; eventsClosed: number }> {
  let detached = 0
  let eventsClosed = 0
  for (const r of rows) {
    const out = await db.$transaction(async (tx) => {
      const check = await tx.check.findUnique({ where: { id: r.checkId }, select: { id: true, status: true, apvNumbers: true } })
      if (!check || !(DETACHED_STATUSES as readonly string[]).includes(check.status)) return null
      const what = await detachFromBills(tx, check)
      const closed = await tx.portalEvent.updateMany({
        where: { checkId: check.id, kind: 'CANCELLED', status: { in: ['PENDING', 'FAILED', 'PARKED'] } },
        data: { status: 'SYNCED', lastError: DETACHED_EVENT_ERROR },
      })
      await tx.check.update({ where: { id: check.id }, data: { portalSyncStatus: 'NOT_APPLICABLE' } })
      const apvs = [...new Set([...what.apvNumbersDetached, ...what.billsDetached.map((b) => b.apvNumber)])].sort()
      await writeAudit(tx, {
        checkId: check.id, actorType: 'SYSTEM', action: APV_DETACHED_ACTION,
        details: { ...what, status: check.status, eventsClosed: closed.count, at: now.toISOString() },
        remarks:
          `Detached from ${apvs.join(', ')}: the check was ${check.status} before the rule that a cancelled ` +
          'check is no longer connected to the AP it was applied to (user ruling 2026-10-29).' +
          (closed.count ? ` ${closed.count} CANCELLED portal event(s) closed unsent.` : ''),
      })
      return closed.count
    }, TX_OPTIONS)
    if (out !== null) {
      detached += 1
      eventsClosed += out
    }
  }
  return { detached, eventsClosed }
}
