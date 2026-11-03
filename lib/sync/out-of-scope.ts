import type { AcumaticaTenant, Prisma, PrismaClient } from '@prisma/client'
import { PAYMENTS_FEED, PAYMENT_FIELDS, type AcumaticaClient } from '@/lib/integrations/acumatica/client'
import { mapPayment, collapseVoidPairs } from '@/lib/integrations/acumatica/map'
import { upsertCheck } from '@/lib/import/upsert'
import { LIVE_STATUSES } from '@/lib/domain/check-status'
import { paymentsInScopeFilter } from './run'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * A LIVE cheque held here whose payment has left the sync's scope — 2026 and
 * the payment-method clause (CHK or CASH since 2026-10-23) — and so is never read again. Full check 2026-10-06:
 * `PCF26-0244` (A1PP-CV-000028) was re-entered in Acumatica as CASH and sat
 * here as a SIGNATURE_PENDING cheque, because the scoped feed cannot return a
 * payment that is no longer a cheque.
 *
 * Each such payment is read by its own reference (one request each: an `or`
 * of several `eq` filters is a 500 in Go-Live) and written through
 * `upsertCheck`, the single write path — so `isCheque`, the amount and the
 * book follow Acumatica. The status is untouched (rule 4) except by upsert's
 * own void path, for a payment Acumatica has since voided — reported as
 * `voided`. A payment Acumatica no longer returns at all is reported, not changed.
 */
export type OutOfScopeResult = {
  candidates: { checkNumber: string; ref: string; status: string }[]
  updated: string[]
  /** Staged by upsert instead (e.g. SHARED_NUMBER), with the reason. */
  staged: string[]
  /** Voided in Acumatica since, so voided here through upsert. */
  voided: string[]
  gone: string[]
  errors: { ref: string; message: string }[]
}

export async function refreshOutOfScope(
  db: Db,
  args: { client: AcumaticaClient; tenant: AcumaticaTenant; now: Date; apply: boolean },
): Promise<OutOfScopeResult> {
  const { client, tenant, now, apply } = args
  const scoped = await client.fetchAll(PAYMENTS_FEED, {
    select: ['ReferenceNbr'], filter: paymentsInScopeFilter(), orderby: 'ReferenceNbr asc', pageSize: 5000,
  })
  const inScope = new Set(scoped.map((r) => String(r.ReferenceNbr ?? '').trim()))
  const held = await db.check.findMany({
    where: { acumaticaTenant: tenant, acumaticaPaymentId: { not: null }, status: { in: [...LIVE_STATUSES] } },
    select: { checkNumber: true, acumaticaPaymentId: true, status: true },
  })
  const candidates = held
    .filter((c) => !inScope.has(c.acumaticaPaymentId!))
    .map((c) => ({ checkNumber: c.checkNumber, ref: c.acumaticaPaymentId!, status: c.status }))

  const result: OutOfScopeResult = { candidates, updated: [], staged: [], voided: [], gone: [], errors: [] }
  if (!apply) return result

  const ownCompanyNames = (await db.company.findMany({ select: { legalNames: true } })).flatMap((c) => c.legalNames)
  for (const c of candidates) {
    try {
      const raw = await client.fetchAll(PAYMENTS_FEED, {
        select: [...PAYMENT_FIELDS], filter: `ReferenceNbr eq '${c.ref.replace(/'/g, "''")}'`, pageSize: 50,
      })
      const rows = collapseVoidPairs(raw.map((r) => mapPayment(r, tenant)).filter((r): r is NonNullable<typeof r> => r !== null))
      const row = rows.find((r) => r.acumaticaPaymentId === c.ref)
      if (!row) { result.gone.push(c.ref); continue }
      const out = await upsertCheck(db, { row, ownCompanyNames, now })
      if (out.outcome === 'STAGED') result.staged.push(`${c.ref} (${out.reason})`)
      else result.updated.push(c.ref)
      // A payment Acumatica has voided since goes through upsert's void path,
      // exactly as in the sync: named separately so the run says so.
      if (row.voided) result.voided.push(c.ref)
    } catch (e) {
      result.errors.push({ ref: c.ref, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}
