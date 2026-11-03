'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { kickPortalDelivery } from '@/lib/sync/portal-kick'
import type { AdminActionResult } from '@/app/admin/actions'

// Refuse a FINANCE_USER by RETURNING, never by redirecting - the same rule as
// app/admin/actions.ts and for the same reason (a redirect is a throw).
const ADMIN_ONLY = 'Only a Finance Admin can manage portal delivery.'

export async function retryPortalEventAction(formData: FormData): Promise<AdminActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY }
  const eventId = String(formData.get('eventId') ?? '').trim()
  const ev = await prisma.portalEvent.findUnique({ where: { id: eventId } })
  if (!ev || (ev.status !== 'PARKED' && ev.status !== 'FAILED')) return { ok: false, message: 'That event is not waiting on a retry.' }
  await prisma.$transaction(async (tx) => {
    await tx.portalEvent.update({ where: { id: ev.id }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null } })
    await writeAudit(tx, { checkId: ev.checkId, actorType: 'USER', userId: user.id, action: 'portal_event_retried', details: { eventId: ev.id, kind: ev.kind, from: ev.status } })
  })
  await kickPortalDelivery(prisma, { budgetMs: 8_000 })
  revalidatePath('/admin/portal')
  return { ok: true }
}

// Every Finance user (user request 2026-10-15): it only sends what is already
// queued - the same delivery every Finance action kicks. RETRY stays admin-only:
// it resets an event that parked for a human to look at.
export async function deliverPortalNowAction(): Promise<AdminActionResult> {
  await requireUser()
  const out = await kickPortalDelivery(prisma, { budgetMs: 25_000 })
  revalidatePath('/admin/portal')
  revalidatePath('/')
  if ('skipped' in out) return { ok: false, message: out.skipped }
  if (out.error) return { ok: false, message: out.error }
  // A refused token stops the run after parking one event (final review
  // 2026-09-26): the button must say so rather than report success.
  if (out.stoppedOnAuth) return { ok: false, message: 'The portal refused the token (401) — check PORTAL_TOKEN.' }
  return { ok: true }
}
