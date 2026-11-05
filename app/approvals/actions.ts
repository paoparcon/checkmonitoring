'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { afterResponse, kickPortalDelivery } from '@/lib/sync/portal-kick'
import { approveAvailabilityRequest, rejectAvailabilityRequest } from '@/lib/domain/availability-approval'
import { loadApprover, canDecide } from '@/lib/approvals/approver'
import { loadSettings } from '@/lib/settings/read'
import { notifyReady } from '@/lib/notifications/ready'
import { notifyApprovalDecided } from '@/lib/notifications/approvals'

/**
 * APPROVE / REJECT (spec 2026-11-05-availability-approval-design §6). The
 * approver in force only — refused by RETURNING, and judged again inside the
 * domain against the setting as it is at that moment. APPROVE applies the
 * domain action as the approver, so its portal event is in the outbox and the
 * kick after the response delivers it; the others are then told of a check
 * that moved, and the requester of the verdict either way.
 */
export type DecisionResult =
  | { ok: true; decided: number; failed: { requestId: string; message: string }[] }
  | { ok: false; message: string }

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const ids = (f: FormData) => f.getAll('requestId').map((v) => String(v)).filter((v) => v !== '')

async function decide(formData: FormData, decision: 'APPROVED' | 'REJECTED'): Promise<DecisionResult> {
  const user = await requireUser()
  const { approver } = await loadApprover(prisma, await loadSettings(prisma))
  if (!canDecide(user, approver)) {
    return { ok: false, message: approver ? `Only ${approver.name} can approve or reject availability changes.` : 'Only a Finance Admin can decide requests while no approver is set.' }
  }
  const requestIds = ids(formData)
  if (requestIds.length === 0) return { ok: false, message: 'Nothing is selected.' }
  const note = str(formData, 'note')
  if (decision === 'REJECTED' && note === '') return { ok: false, message: 'Say why the request is rejected.' }

  const now = new Date()
  const failed: { requestId: string; message: string }[] = []
  const moved: string[] = []
  for (const requestId of requestIds) {
    try {
      if (decision === 'APPROVED') {
        const { request, check } = await approveAvailabilityRequest(prisma, { requestId, actor: user, now, note })
        if (request.kind === 'MAKE_AVAILABLE') moved.push(check.id)
        await notifyApprovalDecided(prisma, {
          requesterId: request.requestedById, approver: user, decision, kind: request.kind,
          check: { id: check.id, checkNumber: check.checkNumber }, note: request.decisionNote,
        })
      } else {
        const request = await rejectAvailabilityRequest(prisma, { requestId, actor: user, now, note })
        const check = await prisma.check.findUnique({ where: { id: request.checkId }, select: { id: true, checkNumber: true } })
        await notifyApprovalDecided(prisma, {
          requesterId: request.requestedById, approver: user, decision, kind: request.kind,
          check: { id: request.checkId, checkNumber: check?.checkNumber ?? null }, note,
        })
      }
      revalidatePath(`/checks/${requestId}`)
    } catch (e) {
      if (isNextControlFlowError(e)) throw e
      if (e instanceof DomainError) { failed.push({ requestId, message: e.message }); continue }
      console.error(e)
      failed.push({ requestId, message: 'Something went wrong with this request. Please try again.' })
    }
  }
  if (moved.length > 0) await notifyReady(prisma, user, moved)
  try {
    afterResponse(() => kickPortalDelivery(prisma, { budgetMs: 8_000 }))
  } catch (e) {
    console.error('portal delivery could not be scheduled:', e instanceof Error ? e.message : e)
  }
  revalidatePath('/')
  revalidatePath('/approvals')
  return { ok: true, decided: requestIds.length - failed.length, failed }
}

export async function approveRequestAction(formData: FormData): Promise<DecisionResult> {
  return decide(formData, 'APPROVED')
}

export async function rejectRequestAction(formData: FormData): Promise<DecisionResult> {
  return decide(formData, 'REJECTED')
}
