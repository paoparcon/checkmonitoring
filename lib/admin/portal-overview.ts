import type { Prisma, PrismaClient, PortalEventStatus, PortalEventKind } from '@prisma/client'
import { lastPortalChecksRun, lastPortalChecksWatermark, type PortalChecksLastRun } from '@/lib/sync/portal-checks'

type Db = PrismaClient | Prisma.TransactionClient

export type PortalAttentionRow = {
  id: string; checkId: string; checkNumber: string; payeeName: string | null
  kind: PortalEventKind; status: PortalEventStatus; attempts: number
  lastError: string | null; nextAttemptAt: Date; createdAt: Date
}

/**
 * SYNCED split by how the row was closed (final review 2026-09-26): the worker
 * closes a row SYNCED without sending it when a newer event supersedes it
 * (`superseded by …`) or its kind no longer matches the cheque (`stale: …`).
 * Counting those as "delivered" would overstate what the portal was told.
 * …or the cheque has no APV for the portal to match (`unmatchable: …`, closed by scripts/close-unmatchable-cancelled.ts).
 */
export type PortalClosedCounts = { delivered: number; superseded: number; stale: number; unmatchable: number }

/** The check list (spec 2026-11-03): the newest push, and how many cheques it has not yet sent. */
export type PortalCheckList = { lastRun: PortalChecksLastRun | null; behind: number; total: number }

export type PortalOverview = { counts: Record<PortalEventStatus, number>; closed: PortalClosedCounts; attention: PortalAttentionRow[]; checkList: PortalCheckList }

const STATUSES: PortalEventStatus[] = ['PENDING', 'IN_FLIGHT', 'SYNCED', 'FAILED', 'PARKED']

/** PARKED is the human's queue; FAILED is shown so a stuck retry is visible before it parks. */
export async function getPortalOverview(db: Db): Promise<PortalOverview> {
  const grouped = await db.portalEvent.groupBy({ by: ['status'], _count: { _all: true } })
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<PortalEventStatus, number>
  for (const g of grouped) counts[g.status] = g._count._all
  const superseded = await db.portalEvent.count({ where: { status: 'SYNCED', lastError: { startsWith: 'superseded by' } } })
  const stale = await db.portalEvent.count({ where: { status: 'SYNCED', lastError: { startsWith: 'stale:' } } })
  const unmatchable = await db.portalEvent.count({ where: { status: 'SYNCED', lastError: { startsWith: 'unmatchable:' } } })
  const closed = { delivered: counts.SYNCED - superseded - stale - unmatchable, superseded, stale, unmatchable }
  const rows = await db.portalEvent.findMany({
    where: { status: { in: ['PARKED', 'FAILED'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
    include: { check: { select: { checkNumber: true, payeeName: true } } },
  })
  const lastRun = await lastPortalChecksRun(db)
  const watermark = await lastPortalChecksWatermark(db)
  const total = await db.check.count()
  const behind = watermark ? await db.check.count({ where: { updatedAt: { gt: watermark } } }) : total
  return {
    counts,
    closed,
    checkList: { lastRun, behind, total },
    attention: rows.map((r) => ({
      id: r.id, checkId: r.checkId, checkNumber: r.check.checkNumber, payeeName: r.check.payeeName,
      kind: r.kind, status: r.status, attempts: r.attempts, lastError: r.lastError,
      nextAttemptAt: r.nextAttemptAt, createdAt: r.createdAt,
    })),
  }
}
