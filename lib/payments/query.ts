import type { Prisma, PrismaClient } from '@prisma/client'
import { isoDay } from '@/lib/domain/details'
import { methodLabel } from '@/lib/integrations/acumatica/other-payments'
import { OTHER_PAYMENTS_MODE } from '@/lib/sync/modes'
import { displayMarking, type Marking } from './marking'

/**
 * OTHER PAYMENTS as the screen and the Excel extract read them: every row,
 * newest payment date first, as plain values (dates as YYYY-MM-DD, amounts as
 * decimal strings - rule 8). One query; the set is small by construction
 * (about 1,700 rows a year).
 */

type Db = PrismaClient | Prisma.TransactionClient

export type PaymentRow = {
  id: string
  tenant: string
  referenceNbr: string
  method: string
  methodLabel: string
  marking: Marking
  voided: boolean
  /** ON PROCESS / PROCESSED / CLEARED, or CANCELLED for a payment Acumatica voided. */
  display: string
  payee: string | null
  vendorCode: string | null
  company: string | null
  branch: string | null
  currency: string | null
  amount: string | null
  paymentDate: string | null
  paymentRef: string | null
  cashAccount: string | null
  acumaticaStatus: string | null
  description: string | null
  processedDate: string | null
  clearedDate: string | null
  bankReference: string | null
  remarks: string | null
  /** Null while the marking is the one the payment arrived with. */
  markedBy: string | null
  markedAt: Date | null
}

export async function listOtherPayments(db: Db): Promise<PaymentRow[]> {
  const rows = await db.otherPayment.findMany({
    include: { markedBy: { select: { name: true } } },
    orderBy: [{ paymentDate: { sort: 'desc', nulls: 'last' } }, { referenceNbr: 'desc' }],
  })
  return rows.map((p) => ({
    id: p.id,
    tenant: p.tenant,
    referenceNbr: p.referenceNbr,
    method: p.method,
    methodLabel: methodLabel(p.method),
    marking: p.marking as Marking,
    voided: p.voided,
    display: displayMarking({ marking: p.marking as Marking, voided: p.voided }),
    payee: p.payeeName,
    vendorCode: p.vendorCode,
    company: p.companyCode,
    branch: p.branch,
    currency: p.currency,
    amount: p.amount?.toFixed(2) ?? null,
    paymentDate: isoDay(p.paymentDate),
    paymentRef: p.paymentRef,
    cashAccount: p.cashAccount,
    acumaticaStatus: p.acumaticaStatus,
    description: p.description,
    processedDate: isoDay(p.processedDate),
    clearedDate: isoDay(p.clearedDate),
    bankReference: p.bankReference,
    remarks: p.remarks,
    markedBy: p.markedBy?.name ?? null,
    markedAt: p.markedAt,
  }))
}

export type LastPaymentsRead = { tenant: string; startedAt: Date; finishedAt: Date | null; errors: number; message: string | null }

/** The newest OTHER_PAYMENTS run per tenant, for the screen's "last read" line. */
export async function lastOtherPaymentsReads(db: Db): Promise<LastPaymentsRead[]> {
  const runs = await db.syncRun.findMany({
    where: { mode: OTHER_PAYMENTS_MODE, tenant: { not: null } },
    orderBy: { startedAt: 'desc' },
    distinct: ['tenant'],
    select: { tenant: true, startedAt: true, finishedAt: true, errors: true, message: true },
  })
  return runs.map((r) => ({ ...r, tenant: r.tenant! })).sort((a, b) => a.tenant.localeCompare(b.tenant))
}
