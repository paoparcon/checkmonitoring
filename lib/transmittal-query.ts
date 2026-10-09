import type { CheckStatus } from '@prisma/client'
import { listChecks, toTableRow } from '@/lib/queries'
import { compareCheckNumbers } from '@/lib/transmittal'
import type { TransmittalCandidate } from '@/lib/transmittal-picker'

type Db = Parameters<typeof listChecks>[0]

/** Above this a pick list says it is short. SIGNATURE PENDING + SIGNED is ~1,400; RELEASED ~10,500. */
export const TRANSMITTAL_PICK_LIMIT = 25_000

/**
 * The checks a transmittal can list, in the picker's row shape: real checks
 * (DEBIT ADV and CASH are not) with a recorded amount, in check-number order.
 * One definition for the page (SIGNATURE PENDING + SIGNED) and for the route
 * that loads RELEASED on demand, so the two cannot drift.
 */
export async function loadTransmittalCandidates(
  db: Db, statuses: readonly CheckStatus[],
): Promise<{ candidates: TransmittalCandidate[]; truncated: boolean }> {
  const rows = await listChecks(
    db, { statusIn: statuses, incomplete: false }, TRANSMITTAL_PICK_LIMIT, { key: 'checkNumber', dir: 'asc' },
  )
  const candidates = rows
    .map(toTableRow)
    .filter((r) => r.isCheque)
    .map((r): TransmittalCandidate => ({
      id: r.id,
      checkNumber: r.checkNumber,
      cashAccount: r.cashAccountCode ?? '',
      poNumber: r.poNumbers.join(', '),
      voucher: r.apvNumbers.join(', '),
      payee: r.payeeName ?? '',
      amount: r.amount,
      currency: r.currency,
      status: r.status === 'SIGNED' || r.status === 'RELEASED' ? r.status : 'SIGNATURE_PENDING',
      company: r.companyCode,
    }))
    .sort((a, b) => compareCheckNumbers(a.checkNumber, b.checkNumber))
  return { candidates, truncated: rows.length >= TRANSMITTAL_PICK_LIMIT }
}
