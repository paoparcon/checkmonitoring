import type { Prisma, PrismaClient } from '@prisma/client'
import type { LoadedSettings } from '@/lib/settings/read'

type Db = PrismaClient | Prisma.TransactionClient

/** The person whose approval an availability change waits on. */
export type Approver = { id: string; name: string; email: string }

export type ApproverInForce = {
  /** The active user the setting names, or null: nobody, and no approval step. */
  approver: Approver | null
  /** The setting holds an id. */
  configured: boolean
  /** The setting holds an id that names no ACTIVE user — treated as nobody, and said on screen. */
  invalid: boolean
}

export const APPROVER_SETTING = 'approval.availabilityApprover' as const

/**
 * Resolves `approval.availabilityApprover` to a person (spec
 * 2026-11-05-availability-approval-design §3). An id that names a deactivated
 * or missing user counts as NOBODY: the gate must never queue a request nobody
 * can decide. Read per request, like every setting.
 */
export async function loadApprover(db: Db, settings: LoadedSettings): Promise<ApproverInForce> {
  const id = settings.values[APPROVER_SETTING]
  if (id === '') return { approver: null, configured: false, invalid: false }
  const user = await db.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, active: true } })
  if (!user || !user.active) return { approver: null, configured: true, invalid: true }
  return { approver: { id: user.id, name: user.name, email: user.email }, configured: true, invalid: false }
}

/** True when `actor` may decide requests: the approver in force, or — when none is set — a Finance Admin, so requests left over from a cleared setting can still be closed. */
export function canDecide(actor: { id: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' }, approver: Approver | null): boolean {
  if (approver) return actor.id === approver.id
  return actor.role === 'FINANCE_ADMIN'
}
