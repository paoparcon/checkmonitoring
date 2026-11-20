'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { SYNC_TENANTS } from '@/lib/admin/sync-overview'
import { createClientForTenant } from '@/lib/integrations/acumatica/from-env'
import { markPayments, type MarkOutcome } from '@/lib/payments/actions'
import { isMarking } from '@/lib/payments/marking'
import { runScheduledOtherPaymentsSync, type ScheduledOtherPaymentsOutcome } from '@/lib/sync/other-payments'

/**
 * OTHER PAYMENTS, off the screen. Every Finance user: a marking is Finance's
 * own record, and a read of Acumatica changes no marking.
 */
export type MarkPaymentsActionResult =
  | { ok: true; marked: number; unchanged: number; refused: { referenceNbr: string | null; message: string }[] }
  | { ok: false; message: string }

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

export async function markPaymentsAction(formData: FormData): Promise<MarkPaymentsActionResult> {
  const user = await requireUser()
  const marking = str(formData, 'marking')
  if (!isMarking(marking)) return { ok: false, message: 'Choose a marking: ON PROCESS, PROCESSED or CLEARED.' }
  try {
    const result = await markPayments(prisma, {
      ids: formData.getAll('paymentId').map(String),
      request: { marking, date: str(formData, 'date'), bankReference: str(formData, 'bankReference'), remarks: str(formData, 'remarks') },
      userId: user.id,
      now: new Date(),
    })
    revalidatePath('/payments')
    return {
      ok: true, marked: result.marked, unchanged: result.unchanged,
      refused: result.outcomes
        .filter((o): o is Extract<MarkOutcome, { ok: false }> => !o.ok)
        .map((o) => ({ referenceNbr: o.referenceNbr, message: o.message })),
    }
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message }
    if (isNextControlFlowError(e)) throw e
    console.error(e)
    return { ok: false, message: 'Something went wrong. Please try again.' }
  }
}

export type RefreshPaymentsResult = { ok: boolean; lines: string[] }

function describe(o: ScheduledOtherPaymentsOutcome): string {
  switch (o.outcome) {
    case 'RAN':
      return `${o.tenant}: ${o.payments.toLocaleString('en-US')} payment(s) read, ${o.created} new, ${o.updated} updated${o.errors > 0 ? `, ${o.errors} error(s) - see the sync log` : ''}.`
    case 'IN_PROGRESS': return `${o.tenant}: a read is already running.`
    case 'SKIPPED_TIME_BUDGET': return `${o.tenant}: skipped.`
    // The failure's own text can carry a URL; it is on the SyncRun row for an admin.
    case 'FAILED': return `${o.tenant}: Acumatica could not be read. The error is recorded in the sync log.`
  }
}

/** Read both tenants now. Never throws; a tenant's failure is its own line. */
export async function refreshPaymentsAction(): Promise<RefreshPaymentsResult> {
  await requireUser()
  const outcomes: ScheduledOtherPaymentsOutcome[] = []
  for (const tenant of SYNC_TENANTS) {
    outcomes.push(await runScheduledOtherPaymentsSync(prisma, {
      tenant, now: new Date(), client: () => createClientForTenant(tenant), trigger: 'MANUAL',
    }))
  }
  revalidatePath('/payments')
  return { ok: outcomes.every((o) => o.outcome === 'RAN' && o.errors === 0), lines: outcomes.map(describe) }
}
