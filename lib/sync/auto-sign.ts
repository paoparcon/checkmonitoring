import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { AUTO_SIGN_RUN_ACTION, SIGNATURE_REVERTED_ACTION, autoSignRunDay, signingCutoff } from '@/lib/domain/auto-sign'

/**
 * THE AUTO-SIGN RUN — RETIRED. Called by /api/cron/sync after both tenants'
 * syncs, at 12:00 and 18:00 Manila, and it signs NOTHING.
 *
 * User ruling 2026-10-22: "We will manually transfer from pending signature to
 * signed." The /admin/settings switch was then the only off, and on Tuesday
 * 2026-10-27 the 12:00 run signed 137 of Monday's checks anyway (reverted the
 * same day, snapshot in snapshots/). User ruling that day: the rule is off in
 * code — no setting can bring it back, and the setting is gone from the
 * registry. Every run still leaves one `auto_sign_run` audit row, DISABLED, so
 * /admin/sync keeps saying what happened. `listAutoSignCandidates` stays as the
 * record of what the rule would have signed; nothing calls it. Rule 4 stands:
 * the sync never writes status.
 */

export type AutoSignRun = {
  outcome: 'OK' | 'DISABLED' | 'IDLE' | 'FAILED'
  signed: number
  /** Listed as due, then found changed inside its own transaction, or deleted before it could be signed. */
  skipped: number
  /** Always false since 2026-10-27; null only on a row recorded before the setting existed. */
  enabled: boolean | null
  error?: string
}

export type AutoSignCandidate = { id: string; checkNumber: string; createdAt: Date; companyCode: string }

/** The database form of `isDueForAutoSign`; `autoSign` re-judges each row with the pure rule. */
export async function listAutoSignCandidates(db: PrismaClient, now: Date): Promise<AutoSignCandidate[]> {
  if (autoSignRunDay(now) === null) return []
  const rows = await db.check.findMany({
    where: {
      status: 'SIGNATURE_PENDING',
      acumaticaPaymentId: { not: null },
      isCheque: true,
      // `{ not: 'Voided' }` alone would drop the nulls: SQL's <> never matches NULL.
      OR: [{ acumaticaStatus: null }, { acumaticaStatus: { not: 'Voided' } }],
      createdAt: { lt: signingCutoff(now) },
      auditLogs: { none: { action: SIGNATURE_REVERTED_ACTION } },
    },
    select: { id: true, checkNumber: true, createdAt: true, company: { select: { code: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((r) => ({ id: r.id, checkNumber: r.checkNumber, createdAt: r.createdAt, companyCode: r.company.code }))
}

export async function runAutoSign(
  db: PrismaClient, _args: { now: Date; deadline?: Date },
): Promise<AutoSignRun> {
  const run: AutoSignRun = { outcome: 'DISABLED', signed: 0, skipped: 0, enabled: false }
  try {
    await writeAudit(db, { actorType: 'SYSTEM', action: AUTO_SIGN_RUN_ACTION, details: { ...run } as Prisma.InputJsonValue })
  } catch {
    // The record of the run could not be written; the caller still gets the outcome.
  }
  return run
}

export type LastAutoSign = AutoSignRun & {
  at: Date
  /**
   * A run recorded under the old "N days after creation" rule (before
   * 2026-10-01) stored `days` and no `enabled`. Non-null only for such a row,
   * so /admin/sync can describe it in its own terms rather than as Monday's.
   */
  legacyDays: number | null
}

export async function getLastAutoSign(db: PrismaClient): Promise<LastAutoSign | null> {
  const row = await db.auditLog.findFirst({
    where: { action: AUTO_SIGN_RUN_ACTION },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (!row) return null
  const d = (row.details ?? {}) as Partial<AutoSignRun> & { days?: unknown }
  const legacyDays = d.enabled === undefined && typeof d.days === 'number' ? d.days : null
  return {
    at: row.createdAt,
    legacyDays,
    outcome: d.outcome ?? 'FAILED',
    signed: d.signed ?? 0,
    skipped: d.skipped ?? 0,
    enabled: d.enabled ?? null,
    ...(d.error ? { error: d.error } : {}),
  }
}
