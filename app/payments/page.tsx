import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { formatManila } from '@/lib/manila-format'
import { manilaToday } from '@/lib/manila-day'
import { lastOtherPaymentsReads, listOtherPayments } from '@/lib/payments/query'
import { AppHeader } from '@/components/AppHeader'
import { PaymentsPicker } from '@/components/PaymentsPicker'

/**
 * OTHER PAYMENTS (2026-11-20): the payments Acumatica records that are not
 * checks - telegraphic transfers (foreign suppliers), letters of credit, DP
 * at sight and manager's checks - each with Finance's marking: ON PROCESS,
 * PROCESSED, CLEARED. A payment exists here only because Acumatica has it
 * ("no Acumatica record, no check" holds for these too); nothing is created,
 * and nothing here reaches the Supplier Portal. `requireUser()` first: it
 * lists payees and amounts.
 */
export const dynamic = 'force-dynamic'
// REFRESH FROM ACUMATICA reads both tenants inside this page's request.
export const maxDuration = 60

export default async function PaymentsPage() {
  const user = await requireUser()
  const now = new Date()
  const [rows, reads] = await Promise.all([listOtherPayments(prisma), lastOtherPaymentsReads(prisma)])

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="OTHER PAYMENTS" back={{ href: '/', label: '← DASHBOARD' }} />
      <p className="text-xs font-medium tracking-wide text-slate-600">
        TELEGRAPHIC TRANSFERS, LETTERS OF CREDIT, DP AT SIGHT AND MANAGER&apos;S CHECKS, AS RECORDED IN ACUMATICA (PAYMENTS DATED 2026 ONWARD).
        AMOUNTS ARE IN EACH PAYMENT&apos;S OWN CURRENCY AND ARE NEVER ADDED ACROSS CURRENCIES. A PAYMENT VOIDED IN ACUMATICA READS CANCELLED.
        {' '}
        {reads.length === 0
          ? 'ACUMATICA HAS NOT BEEN READ FOR THESE YET.'
          : `LAST READ: ${reads.map((r) => `${r.tenant} ${formatManila(r.startedAt, { dateStyle: 'medium', timeStyle: 'short' })}${r.errors > 0 ? ' (WITH ERRORS)' : ''}`).join(' · ')}.`}
      </p>
      <PaymentsPicker rows={rows} today={manilaToday(now)} />
    </main>
  )
}
