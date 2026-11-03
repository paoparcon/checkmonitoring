import type { PrismaClient } from '@prisma/client'
import { revertSignature } from '@/lib/domain/actions'
import { DomainError } from '@/lib/domain/errors'

/**
 * SIGNED -> SIGNATURE_PENDING for every check first read on or after a Manila
 * day (user ruling 2026-10-22: "All checks created last October 19, 2026 to
 * present, that status today is SIGNED, revert it back"; signing is manual from
 * now on and auto-sign is switched off on /admin/settings).
 *
 * Through `revertSignature` only, one check per transaction: the same guard on
 * SIGNED, one `signature_reverted` row each, no portal event — and a reverted
 * check is never auto-signed again.
 */

export type RecentSigned = {
  id: string; checkNumber: string; companyCode: string; createdAt: Date
  /** null when the auto-sign run signed it. */
  signedById: string | null
  signedAt: Date | null
}

/** 00:00 Manila on `day` (YYYY-MM-DD), as an instant. */
export function manilaDayStart(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Not a YYYY-MM-DD day: ${day}`)
  return new Date(`${day}T00:00:00+08:00`)
}

export async function findRecentSigned(db: PrismaClient, from: Date): Promise<RecentSigned[]> {
  const rows = await db.check.findMany({
    where: { status: 'SIGNED', createdAt: { gte: from } },
    select: { id: true, checkNumber: true, createdAt: true, signedById: true, signedAt: true, company: { select: { code: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return rows.map(({ company, ...r }) => ({ ...r, companyCode: company.code }))
}

export type RevertOutcome = { reverted: string[]; refused: { checkNumber: string; reason: string }[] }

/** A check that changed status since it was listed is refused and reported, never forced. */
export async function revertRecentSigned(
  db: PrismaClient, rows: readonly RecentSigned[], args: { userId: string; reason: string; now: Date },
): Promise<RevertOutcome> {
  const out: RevertOutcome = { reverted: [], refused: [] }
  for (const r of rows) {
    try {
      await revertSignature(db, { checkId: r.id, userId: args.userId, reason: args.reason, now: args.now })
      out.reverted.push(r.checkNumber)
    } catch (e) {
      if (!(e instanceof DomainError)) throw e
      out.refused.push({ checkNumber: r.checkNumber, reason: e.message })
    }
  }
  return out
}
