import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { withdrawOnCancel, type DetachedBills } from '@/lib/domain/actions'
import { portalRoute, type Eligibility } from '@/lib/domain/eligibility'
import { deliveredToPortal } from '@/lib/integrations/portal/delivered'

type Db = PrismaClient | Prisma.TransactionClient

/** Each row is several round trips to ap-southeast-1; Prisma's 5s default would kill the run. */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const

/** The audit action this repair writes, one per cheque it queues a REVERT for. */
export const WITHDRAWN_AFTER_CANCEL_ACTION = 'availability_withdrawn_after_cancel'

/** The audit rows a cancellation's detached vouchers are read from, newest first. */
const DETACH_ACTIONS = ['cancelled', 'voided', 'voided_after_release', 'apv_detached_on_cancel']

export type DeadAvailableRow = {
  checkId: string
  checkNumber: string
  status: 'CANCELLED' | 'VOIDED'
  /** The kind and time of the last message the portal accepted for it. */
  lastTold: string
  lastToldAt: Date
  /** What the cancellation detached, read off its audit row. Empty = nothing to match on. */
  detached: DetachedBills
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])

/**
 * Every CANCELLED or VOIDED portal-routed cheque the portal still lists as
 * AVAILABLE: its newest delivered (or in-flight) status-lane event is
 * MARK_AVAILABLE or RELEASE_REVERSED. They were cancelled before `voidCheck` /
 * `cancelCheck` learned to withdraw them (ruling 2026-11-19; measured that day,
 * `1791406353` and `6000318593`). Read-only. Prints no amounts.
 */
export async function findDeadAvailable(db: Db): Promise<DeadAvailableRow[]> {
  const cheques = await db.check.findMany({
    where: {
      status: { in: ['CANCELLED', 'VOIDED'] },
      portalEvents: { some: { kind: { in: ['MARK_AVAILABLE', 'RELEASE_REVERSED'] }, status: { in: ['SYNCED', 'IN_FLIGHT'] } } },
    },
    orderBy: [{ checkNumber: 'asc' }, { id: 'asc' }],
    select: {
      id: true, checkNumber: true, status: true, eligibility: true,
      portalEvents: {
        where: { kind: { not: 'RECEIPT' } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { kind: true, status: true, lastError: true, createdAt: true },
      },
    },
  })
  const out: DeadAvailableRow[] = []
  for (const c of cheques) {
    if (portalRoute(c.eligibility as Eligibility) === null) continue
    // An open REVERT already says what this repair would say.
    if (c.portalEvents.some((e) => e.kind === 'REVERT' && (e.status === 'PENDING' || e.status === 'FAILED'))) continue
    const told = c.portalEvents.filter((e) => e.status === 'IN_FLIGHT' || deliveredToPortal(e)).at(-1)
    if (!told || (told.kind !== 'MARK_AVAILABLE' && told.kind !== 'RELEASE_REVERSED')) continue
    const audit = await db.auditLog.findFirst({
      where: { checkId: c.id, action: { in: DETACH_ACTIONS } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { details: true },
    })
    const d = (audit?.details ?? {}) as Record<string, unknown>
    const bills = Array.isArray(d.billsDetached) ? (d.billsDetached as DetachedBills['billsDetached']) : []
    out.push({
      checkId: c.id, checkNumber: c.checkNumber, status: c.status as 'CANCELLED' | 'VOIDED',
      lastTold: told.kind, lastToldAt: told.createdAt,
      detached: { apvNumbersDetached: asStrings(d.apvNumbersDetached), billsDetached: bills },
    })
  }
  return out
}

export type WithdrawDeadResult = { checkNumber: string; withdrawn: string[]; heldByAnother: string[]; skipped?: string }

/**
 * Queue the REVERT `voidCheck` would queue today for each row — the same
 * `withdrawOnCancel`, so the same guard: a voucher another cheque holds at
 * READY, SCHEDULED or RELEASED is left to that cheque. One audit row per
 * cheque a REVERT is queued for; a cheque that moved since the read is skipped.
 */
export async function withdrawDeadAvailable(db: PrismaClient, rows: DeadAvailableRow[], now: Date): Promise<WithdrawDeadResult[]> {
  const results: WithdrawDeadResult[] = []
  for (const row of rows) {
    results.push(await db.$transaction(async (tx) => {
      const check = await tx.check.findUnique({ where: { id: row.checkId }, select: { id: true, checkNumber: true, eligibility: true, status: true } })
      if (!check || (check.status !== 'CANCELLED' && check.status !== 'VOIDED')) {
        return { checkNumber: row.checkNumber, withdrawn: [], heldByAnother: [], skipped: `now ${check?.status ?? 'gone'}` }
      }
      const outcome = await withdrawOnCancel(tx, check, row.detached, now)
      if (!outcome) return { checkNumber: row.checkNumber, withdrawn: [], heldByAnother: [], skipped: 'no voucher on record, or no longer listed' }
      if (outcome.withdrawn.length === 0) return { checkNumber: row.checkNumber, ...outcome, skipped: 'every voucher is held by another cheque' }
      await tx.check.update({ where: { id: check.id }, data: { portalSyncStatus: 'PENDING' } })
      await writeAudit(tx, {
        checkId: check.id, actorType: 'SYSTEM', action: WITHDRAWN_AFTER_CANCEL_ACTION,
        details: {
          portalEvent: 'REVERT', portalWithdrawn: outcome.withdrawn,
          ...(outcome.heldByAnother.length ? { portalHeldByAnother: outcome.heldByAnother } : {}),
          lastTold: row.lastTold, lastToldAt: row.lastToldAt.toISOString(), status: check.status,
        },
        remarks: `The portal still listed this ${check.status} cheque as available. Its availability is withdrawn there (user ruling 2026-11-19).`,
      })
      return { checkNumber: row.checkNumber, ...outcome }
    }, TX_OPTIONS))
  }
  return results
}
