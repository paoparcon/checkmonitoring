import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from '@/lib/domain/errors'

/**
 * Cheques CANCELLED here by the retired register alone — created from its
 * CANCELLED sheet on 2026-09-04, never cancelled by anyone in this app — while
 * Acumatica holds the payment live (Closed or Balanced, not Voided). The
 * 2026-10-06 reconcile settled 63 of these on Finance's verdicts; the ones
 * here were missed by it or went Closed after it. First seen 2026-10-30:
 * `1791363258` (CV-A1011925, Closed) was on the FOR RELEASE list, and the
 * upload could not find it because the 2026-10-29 detach had stripped its
 * bill off a cancelled cheque.
 *
 * `reinstate` puts a named cheque back to SIGNED and re-attaches the bills
 * the detach took off it (read from its own `apv_detached_on_cancel` audit
 * row). Status only beyond that: no pickup date, no portal event — the ready
 * list upload does that, under the admin who confirms it. Approval-workbook
 * `CheckBill` rows the detach deleted are not rebuilt (they carry an amount
 * nobody can restate); the count is reported.
 */

export const REINSTATED_ACTION = 'cancel_reverted_register_only'
const DETACH_ACTION = 'apv_detached_on_cancel'

export type RegisterCancelled = {
  id: string
  checkNumber: string
  companyCode: string
  payeeName: string | null
  acumaticaPaymentId: string | null
  acumaticaStatus: string | null
  checkDate: string | null
  registerRow: number | null
  /** Vouchers the 2026-10-29 detach removed, to put back. */
  detachedVouchers: string[]
  /** `CheckBill` rows the detach deleted; not rebuilt. */
  detachedBills: number
  vouchersNow: string[]
  /** A ruling already on record that says it stays CANCELLED; null when nobody has ruled. */
  ruling: string | null
}

const SELECT = {
  id: true, checkNumber: true, payeeName: true, acumaticaPaymentId: true, acumaticaStatus: true, checkDate: true,
  sourceRow: true, apvNumbers: true, isStale: true, eligibility: true, company: { select: { code: true } },
} satisfies Prisma.CheckSelect

/** Audit actions that record a decision to leave the cheque CANCELLED. */
const RULING_ACTIONS: Readonly<Record<string, string>> = {
  marked_stale_by_finance: 'Finance: STALED (2026-10-07) — stays CANCELLED',
  reconcile_available_reverted: 'user ruling 2026-10-07 — stays CANCELLED',
}

export async function findRegisterCancelled(db: PrismaClient): Promise<RegisterCancelled[]> {
  const rows = await db.check.findMany({
    where: {
      status: 'CANCELLED', sourceSheet: 'CANCELLED', cancelledById: null, cancelledAt: null,
      acumaticaPaymentId: { not: null }, acumaticaStatus: { in: ['Closed', 'Balanced'] }, voidedAt: null,
    },
    select: SELECT,
    orderBy: { checkNumber: 'asc' },
  })
  const audit = await db.auditLog.findMany({
    where: { action: { in: [DETACH_ACTION, ...Object.keys(RULING_ACTIONS)] }, checkId: { in: rows.map((r) => r.id) } },
    select: { checkId: true, action: true, details: true },
    orderBy: { createdAt: 'asc' },
  })
  const rulings = new Map<string, string>()
  const byCheck = new Map<string, { vouchers: string[]; bills: number }>()
  for (const d of audit) {
    if (d.action !== DETACH_ACTION) { rulings.set(d.checkId!, RULING_ACTIONS[d.action]); continue }
    const det = d.details as { apvNumbersDetached?: string[]; billsDetached?: unknown[] } | null
    const prev = byCheck.get(d.checkId!) ?? { vouchers: [], bills: 0 }
    byCheck.set(d.checkId!, {
      vouchers: [...new Set([...prev.vouchers, ...(det?.apvNumbersDetached ?? [])])],
      bills: prev.bills + (det?.billsDetached?.length ?? 0),
    })
  }
  return rows.map((r) => ({
    id: r.id, checkNumber: r.checkNumber, companyCode: r.company.code, payeeName: r.payeeName,
    acumaticaPaymentId: r.acumaticaPaymentId, acumaticaStatus: r.acumaticaStatus,
    checkDate: r.checkDate?.toISOString().slice(0, 10) ?? null, registerRow: r.sourceRow,
    detachedVouchers: byCheck.get(r.id)?.vouchers ?? [], detachedBills: byCheck.get(r.id)?.bills ?? 0,
    vouchersNow: r.apvNumbers,
    ruling: rulings.get(r.id) ?? (r.isStale ? RULING_ACTIONS.marked_stale_by_finance : null) ?? (r.eligibility === 'INTERNAL' ? 'INTERNAL — never goes to the portal' : null),
  }))
}

export type ReinstateOutcome = { checkNumber: string; ok: boolean; reason?: string }

export async function reinstateRegisterCancelled(
  db: PrismaClient, items: readonly RegisterCancelled[], args: { now: Date; instruction: string },
): Promise<ReinstateOutcome[]> {
  const out: ReinstateOutcome[] = []
  for (const item of items) {
    try {
      await db.$transaction(async (tx) => {
        const before = await tx.check.findUniqueOrThrow({ where: { id: item.id }, select: { status: true, apvNumbers: true, acumaticaStatus: true } })
        if (before.status !== 'CANCELLED') throw new DomainError('MOVED', `it is ${before.status} now`)
        if (before.acumaticaStatus === 'Voided') throw new DomainError('VOIDED', 'Acumatica now says Voided')
        const apvNumbers = [...new Set([...before.apvNumbers, ...item.detachedVouchers])].sort()
        await tx.check.update({ where: { id: item.id }, data: { status: 'SIGNED', apvNumbers } })
        await writeAudit(tx, {
          checkId: item.id, actorType: 'SYSTEM', action: REINSTATED_ACTION,
          details: {
            from: 'CANCELLED', to: 'SIGNED', registerSheet: 'CANCELLED', registerRow: item.registerRow,
            acumaticaPaymentId: item.acumaticaPaymentId, acumaticaStatus: before.acumaticaStatus,
            apvNumbersReattached: item.detachedVouchers, billsNotRebuilt: item.detachedBills,
          },
          remarks: `Cancelled only by the retired register; live in Acumatica. ${args.instruction} Recorded by scripts/reinstate-register-cancelled.ts.`,
        })
      }, { timeout: 30_000, maxWait: 15_000 })
      out.push({ checkNumber: item.checkNumber, ok: true })
    } catch (e) {
      out.push({ checkNumber: item.checkNumber, ok: false, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}
