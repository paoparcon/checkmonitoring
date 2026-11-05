import type { PrismaClient } from '@prisma/client'
import { approvalRequestedNotice, approvalDecidedNotice } from './messages'
import { safeNotify } from './notify'

/**
 * The two approval notices (spec 2026-11-05-availability-approval-design §8),
 * written after the request or the decision committed; neither can fail the
 * action. Amounts are read back from the database, never taken from a form.
 */
export async function notifyApprovalRequested(
  db: PrismaClient,
  a: { approverId: string; requester: { name: string }; kind: 'MAKE_AVAILABLE' | 'WITHDRAW'; checkIds: readonly string[]; pickupDay?: string | null; reason?: string | null },
): Promise<void> {
  if (a.checkIds.length === 0) return
  try {
    const checks = await db.check.findMany({
      where: { id: { in: [...a.checkIds] } },
      select: { id: true, checkNumber: true, amount: true, currency: true },
      orderBy: { checkNumber: 'asc' },
    })
    await safeNotify(db, approvalRequestedNotice({
      approverId: a.approverId, requesterName: a.requester.name, kind: a.kind,
      checks: checks.map((c) => ({ id: c.id, checkNumber: c.checkNumber, amount: c.amount?.toString() ?? null, currency: c.currency })),
      pickupDay: a.pickupDay ?? null, reason: a.reason ?? null,
    }))
  } catch (e) {
    console.error('approval-requested notification could not be written:', e instanceof Error ? e.message : e)
  }
}

export async function notifyApprovalDecided(
  db: PrismaClient,
  a: { requesterId: string; approver: { id: string; name: string }; decision: 'APPROVED' | 'REJECTED'; kind: 'MAKE_AVAILABLE' | 'WITHDRAW'; check: { id: string; checkNumber: string | null }; note: string | null },
): Promise<void> {
  // The approver deciding their own leftover request is told nothing.
  if (a.requesterId === a.approver.id) return
  await safeNotify(db, approvalDecidedNotice({
    requesterId: a.requesterId, approverName: a.approver.name, decision: a.decision, kind: a.kind, check: a.check, note: a.note,
  }))
}
