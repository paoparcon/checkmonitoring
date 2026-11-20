import type { PrismaClient } from '@prisma/client'
import { writeAudits, type AuditInput } from '@/lib/audit'
import { DomainError } from '@/lib/domain/errors'
import { dayToDate, isoDay } from '@/lib/domain/details'
import { manilaToday } from '@/lib/manila-day'
import { checkMarkingRequest, planMarking, type Marking, type MarkingRequest } from './marking'

/**
 * Setting a marking on OTHER PAYMENTS - the only writer of `OtherPayment`'s
 * marking columns (the sync writes the Acumatica ones and sets `marking` only
 * when it creates a row).
 *
 * One transaction for the whole selection: every payment is read, judged by
 * `planMarking`, and the ones that pass are written by marking-they-came-from
 * with one audit row each (`other_payment_marked`; `checkId` none - these are
 * not checks - and the payment's reference in `details`). A payment that is
 * refused is reported by reference and nothing is written for it; the others
 * still go through.
 */

const TX = { timeout: 30_000, maxWait: 15_000 } as const

export type MarkOutcome =
  | { id: string; referenceNbr: string | null; ok: true; changed: boolean }
  | { id: string; referenceNbr: string | null; ok: false; message: string }

export type MarkPaymentsResult = { marked: number; unchanged: number; refused: number; outcomes: MarkOutcome[] }

export async function markPayments(
  db: PrismaClient,
  args: { ids: readonly string[]; request: MarkingRequest; userId: string; now: Date },
): Promise<MarkPaymentsResult> {
  const ids = [...new Set(args.ids.map((id) => id.trim()).filter((id) => id !== ''))]
  if (ids.length === 0) throw new DomainError('NOTHING_SELECTED', 'Tick at least one payment.')
  const guard = checkMarkingRequest(args.request, manilaToday(args.now))
  if (!guard.ok) throw new DomainError(guard.code, guard.message)
  const { request } = args

  return db.$transaction(async (tx) => {
    const found = await tx.otherPayment.findMany({ where: { id: { in: ids } } })
    const byId = new Map(found.map((p) => [p.id, p]))
    const outcomes: MarkOutcome[] = []
    const audits: AuditInput[] = []
    let marked = 0

    for (const id of ids) {
      const p = byId.get(id)
      if (!p) {
        outcomes.push({ id, referenceNbr: null, ok: false, message: 'Payment not found.' })
        continue
      }
      const before = {
        marking: p.marking as Marking, voided: p.voided,
        processedDate: isoDay(p.processedDate), clearedDate: isoDay(p.clearedDate),
        bankReference: p.bankReference, remarks: p.remarks,
      }
      const verdict = planMarking(before, request)
      if (!verdict.ok) {
        outcomes.push({ id, referenceNbr: p.referenceNbr, ok: false, message: verdict.message })
        continue
      }
      if (verdict.change === null) {
        outcomes.push({ id, referenceNbr: p.referenceNbr, ok: true, changed: false })
        continue
      }
      const c = verdict.change
      // Conditional on the marking and the void flag that were judged, so a
      // payment another user marked (or the sync voided) in between is not
      // silently overwritten.
      const wrote = await tx.otherPayment.updateMany({
        where: { id: p.id, marking: p.marking, voided: false },
        data: {
          marking: c.marking,
          processedDate: c.processedDate ? dayToDate(c.processedDate) : null,
          clearedDate: c.clearedDate ? dayToDate(c.clearedDate) : null,
          bankReference: c.bankReference, remarks: c.remarks,
          markedById: args.userId, markedAt: args.now,
        },
      })
      if (wrote.count !== 1) {
        outcomes.push({ id, referenceNbr: p.referenceNbr, ok: false, message: 'Changed by someone else just now. Reload and try again.' })
        continue
      }
      marked++
      outcomes.push({ id, referenceNbr: p.referenceNbr, ok: true, changed: true })
      audits.push({
        actorType: 'USER', userId: args.userId, action: 'other_payment_marked',
        remarks: request.remarks.trim() || undefined,
        details: {
          otherPaymentId: p.id, tenant: p.tenant, referenceNbr: p.referenceNbr, method: p.method,
          payee: p.payeeName, amount: p.amount?.toFixed(2) ?? null, currency: p.currency,
          from: before.marking, to: c.marking,
          processedDate: c.processedDate, clearedDate: c.clearedDate, bankReference: c.bankReference,
          acumaticaStatus: p.acumaticaStatus,
        },
      })
    }

    await writeAudits(tx, audits)
    const refused = outcomes.filter((o) => !o.ok).length
    return { marked, unchanged: outcomes.length - marked - refused, refused, outcomes }
  }, TX)
}
