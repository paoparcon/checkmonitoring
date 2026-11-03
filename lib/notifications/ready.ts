import type { PrismaClient } from '@prisma/client'
import { readyNotice } from './messages'
import { safeNotify } from './notify'

/**
 * One notification for one READY FOR RELEASE action, to every active user
 * except the actor (spec 2026-10-16-notifications-design.md). `checkIds` are
 * the checks that MOVED; the amounts are read back from the database, never
 * taken from the form. Called after the action committed, so it never throws.
 */
export async function notifyReady(
  db: PrismaClient, actor: { id: string; name: string }, checkIds: readonly string[],
): Promise<void> {
  if (checkIds.length === 0) return
  try {
    const checks = await db.check.findMany({
      where: { id: { in: [...checkIds] } },
      select: { checkNumber: true, amount: true, currency: true },
      orderBy: { checkNumber: 'asc' },
    })
    const notice = readyNotice({
      actorName: actor.name,
      checks: checks.map((c) => ({ checkNumber: c.checkNumber, amount: c.amount?.toString() ?? null, currency: c.currency })),
    })
    await safeNotify(db, notice, { excludeUserId: actor.id })
  } catch (e) {
    console.error('ready-for-release notification could not be written:', e instanceof Error ? e.message : e)
  }
}
