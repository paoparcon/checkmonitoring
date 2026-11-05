'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { afterResponse, kickPortalDelivery } from '@/lib/sync/portal-kick'
import {
  markSigned,
  releaseDirectly, recordClearing, cancelCheck, deleteIncompleteCheck, recordReceipt,
  reverseRelease, updateDetails, revertSignature, restoreCancelled, attachReceiptFile, removeReceipt,
  REVERSAL_DESTINATIONS, type ReversalDestination,
} from '@/lib/domain/actions'
import { readReceiptFields } from '@/lib/receipt-form'
import { notifyReady } from '@/lib/notifications/ready'
import { notifyApprovalRequested } from '@/lib/notifications/approvals'
import { loadSettings } from '@/lib/settings/read'
import { loadApprover } from '@/lib/approvals/approver'
import { applyOrRequest, type AvailabilityKind, type GateOutcome } from '@/lib/domain/availability-approval'
import { isoDay } from '@/lib/domain/details'

/**
 * `requested` (2026-11-05): the action wrote a request for the approver named,
 * not the change itself — the check has not moved. The form says so instead of
 * "Check is now READY FOR RELEASE".
 */
export type ActionResult = { ok: true; requested?: { approverName: string } } | { ok: false; message: string }

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const date = (f: FormData, k: string) => {
  const v = str(f, k)
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

const clearingStatusSchema = z.enum(['NONE', 'DEPOSITED', 'ENCASHED', 'CLEARED'])

// A receipt event carries up to ~4 MB; give its kick the same 25 s as the
// admin "Deliver now" so it goes out now, not at the next cron (review
// 2026-10-02, second pass).
const RECEIPT_KICK = 25_000

// Domain errors carry user-facing copy written to the spec; anything else is a
// bug and must not leak its message to a Finance user.
async function run(checkId: string, fn: () => Promise<unknown>, opts: { budgetMs?: number } = {}): Promise<ActionResult> {
  try {
    await fn()
    // Deliver the outbox row this action just wrote, after the response is
    // sent so the Finance user never waits on the portal (spec 2026-09-26-
    // check-monitoring-integration-design §2.4). Best-effort: a portal outage
    // is the worker's problem, never this action's. Its own try/catch (final
    // review 2026-09-26): the action has committed, so nothing thrown while
    // scheduling the kick may turn it into { ok: false }.
    try {
      afterResponse(() => kickPortalDelivery(prisma, { budgetMs: opts.budgetMs ?? 8_000 }))
    } catch (e) {
      console.error('portal delivery could not be scheduled:', e instanceof Error ? e.message : e)
    }
    revalidatePath('/')
    revalidatePath(`/checks/${checkId}`)
    return { ok: true }
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message }
    // Next implements redirect()/notFound() by throwing; these must propagate.
    if (isNextControlFlowError(e)) throw e
    console.error(e)
    return { ok: false, message: 'Something went wrong. Please try again.' }
  }
}

export async function signAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return run(checkId, () => markSigned(prisma, { checkId, userId: user.id, now: new Date() }))
}

/**
 * THE TWO GATED ACTIONS (spec 2026-11-05-availability-approval-design §5).
 * `applyOrRequest` applies the change when nobody is set as approver or the
 * actor is the approver, and records a request otherwise. The notices follow
 * the outcome: the others hear of a check that MOVED, the approver hears of a
 * request. Both after the write committed; neither can fail the action.
 */
async function gated(
  user: { id: string; name: string }, checkId: string, kind: AvailabilityKind,
  fields: { availablePickupDate?: Date | null; reason?: string },
): Promise<ActionResult> {
  const { approver } = await loadApprover(prisma, await loadSettings(prisma))
  // A holder, not a `let`: TypeScript narrows a variable assigned inside a
  // closure to its initial null and reads the branch below as unreachable.
  const box: { outcome: GateOutcome | null } = { outcome: null }
  const result = await run(checkId, async () => {
    box.outcome = await applyOrRequest(prisma, { kind, checkId, actor: user, approver, now: new Date(), ...fields })
  })
  if (!result.ok || box.outcome === null) return result
  const o = box.outcome
  if (o.applied) {
    if (kind === 'MAKE_AVAILABLE') await notifyReady(prisma, user, [checkId])
    return result
  }
  await notifyApprovalRequested(prisma, {
    approverId: approver!.id, requester: user, kind, checkIds: [checkId],
    pickupDay: fields.availablePickupDate ? isoDay(fields.availablePickupDate) : null, reason: fields.reason ?? null,
  })
  return { ok: true, requested: { approverName: approver!.name } }
}

export async function readyForReleaseAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return gated(user, checkId, 'MAKE_AVAILABLE', { availablePickupDate: date(formData, 'availablePickupDate') })
}

export async function revertAction(formData: FormData): Promise<ActionResult> {
  // Every Finance user since 2026-09-26 (client ruling), matching the list's
  // REVERT TO SIGNED. The reason stays mandatory — the domain refuses a blank one.
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return gated(user, checkId, 'WITHDRAW', { reason: str(formData, 'reason') })
}

export async function revertSignatureAction(formData: FormData): Promise<ActionResult> {
  // Every Finance user (client, 2026-10-01). The reason is optional.
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return run(checkId, () => revertSignature(prisma, {
    checkId, userId: user.id, reason: str(formData, 'reason'), now: new Date(),
  }))
}

export async function restoreCancelledAction(formData: FormData): Promise<ActionResult> {
  // Every Finance user (client, 2026-10-06); the reason is required by the domain.
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return run(checkId, () => restoreCancelled(prisma, {
    checkId, userId: user.id, reason: str(formData, 'reason'), now: new Date(),
  }))
}

/**
 * A release, undone. FINANCE_ADMIN only — the same guard as `revertAction`,
 * one rung up. The reason is required by the domain; the page requires it too,
 * but the domain is what enforces it. Refusals for a recorded receipt or a
 * cleared cheque arrive as `DomainError`s and are shown as their own words.
 */
export async function reverseReleaseAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') {
    return { ok: false, message: 'Only a Finance Admin can reverse a release.' }
  }
  const checkId = str(formData, 'checkId')
  // DESTINATION (2026-11-03): READY FOR RELEASE or SIGNED; absent means the
  // original one-rung reversal, anything else is refused by name rather than
  // read as a default. The date is read only for a cheque that has none
  // (released outside the app); the domain ignores it otherwise.
  const destination = str(formData, 'destination') || 'READY_FOR_RELEASE'
  if (!(REVERSAL_DESTINATIONS as readonly string[]).includes(destination)) {
    return { ok: false, message: `Unknown destination "${destination}": choose READY FOR RELEASE or SIGNED.` }
  }
  return run(checkId, () => reverseRelease(prisma, {
    checkId, userId: user.id,
    reason: str(formData, 'reason'), now: new Date(),
    destination: destination as ReversalDestination,
    availablePickupDate: date(formData, 'availablePickupDate'),
  }))
}

/**
 * A receipt recorded by mistake, removed (2026-10-23). FINANCE_ADMIN only, the
 * same guard as `reverseReleaseAction`, which it unblocks; the domain requires
 * the reason and refuses a cleared check or a receipt the portal already holds.
 */
export async function removeReceiptAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') {
    return { ok: false, message: 'Only a Finance Admin can remove a receipt.' }
  }
  const checkId = str(formData, 'checkId')
  return run(checkId, () => removeReceipt(prisma, {
    checkId, userId: user.id, reason: str(formData, 'reason'), now: new Date(),
  }))
}

export async function releaseAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  const receipt = await readReceiptFields(formData)
  if (!receipt.ok) return { ok: false, message: receipt.message }
  return run(checkId, () => releaseDirectly(prisma, {
    checkId, userId: user.id,
    orNumber: receipt.orNumber,
    orDate: receipt.orDate,
    receiptType: receipt.receiptType,
    receiptAmount: receipt.receiptAmount,
    receiptFile: receipt.receiptFile,
    remarks: str(formData, 'remarks') || undefined,
    now: new Date(),
  }), receipt.orNumber ? { budgetMs: RECEIPT_KICK } : {})
}

/**
 * The receipt a supplier hands over, typed in after the cheque was released.
 *
 * Open to any signed-in Finance user, like `releaseAction` beside it. It
 * records a reference against a release that has already happened; it moves no
 * status, releases no money, and cannot clear a receipt that is already there
 * (`recordReceipt` refuses an overwrite). The audit row names whoever typed it.
 */
export async function recordReceiptAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  const receipt = await readReceiptFields(formData)
  if (!receipt.ok) return { ok: false, message: receipt.message }
  return run(checkId, () => recordReceipt(prisma, {
    checkId, userId: user.id,
    orNumber: receipt.orNumber ?? '',
    orDate: receipt.orDate,
    receiptType: receipt.receiptType,
    receiptAmount: receipt.receiptAmount,
    receiptFile: receipt.receiptFile,
    now: new Date(),
  }), { budgetMs: RECEIPT_KICK })
}

/**
 * Add the amount and/or the file to a receipt already recorded (add-only; the
 * domain refuses an overwrite). user request 2026-10-01.
 */
export async function attachReceiptFileAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  const receipt = await readReceiptFields(formData)
  if (!receipt.ok) return { ok: false, message: receipt.message }
  return run(checkId, () => attachReceiptFile(prisma, {
    checkId, userId: user.id, receiptAmount: receipt.receiptAmount, receiptFile: receipt.receiptFile, now: new Date(),
  }), { budgetMs: RECEIPT_KICK })
}

/**
 * The register's four free-text fields. Any Finance user, any status: the
 * domain's `updateDetails` has no status guard by design, and reports success
 * when nothing changed rather than an error, because "saved, no change" is not
 * a mistake anyone made.
 */
export async function updateDetailsAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return run(checkId, () => updateDetails(prisma, {
    checkId, userId: user.id, now: new Date(),
    fields: {
      remarks: str(formData, 'remarks'),
      pointPerson: str(formData, 'pointPerson'),
      checksPossession: str(formData, 'checksPossession'),
      category: str(formData, 'category'),
      expectedOutflowDate: str(formData, 'expectedOutflowDate'),
    },
  }))
}

export async function clearingAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  const parsed = clearingStatusSchema.safeParse(str(formData, 'clearingStatus'))
  if (!parsed.success) return { ok: false, message: 'Invalid clearing status.' }
  return run(checkId, () => recordClearing(prisma, {
    checkId, userId: user.id,
    clearingStatus: parsed.data,
    crNumber: str(formData, 'crNumber') || undefined,
    clearedDate: date(formData, 'clearedDate') ?? undefined,
    now: new Date(),
  }))
}

/**
 * The only endpoint in this application that deletes a cheque.
 *
 * Like `revertAction` and `cancelAction`, it refuses a FINANCE_USER by
 * RETURNING a result rather than redirecting: `requireAdmin` redirects, Next
 * implements a redirect by throwing, and `run()`'s catch would swallow it and
 * report "Something went wrong" on an action the user is not entitled to.
 *
 * The role is checked here AND again in `deleteIncompleteCheck`. That is not
 * belt-and-braces for its own sake — a server action is an HTTP endpoint,
 * reachable by anyone holding a session whether or not a button points at it,
 * and the domain rule has to hold for every caller of the domain function too.
 *
 * `run()` revalidates `/checks/${checkId}` for a cheque that no longer exists,
 * which is exactly right: the cached page must go. The screen sends the user
 * back to the dashboard, because the page they were on is now a 404.
 */
export async function deleteIncompleteCheckAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') {
    // The same sentence `checkDeletable` returns for NOT_ADMIN, so a Finance
    // user reads one wording whichever layer refused them.
    return { ok: false, message: 'Only a Finance Admin can delete a check record.' }
  }
  const checkId = str(formData, 'checkId')
  return run(checkId, () => deleteIncompleteCheck(prisma, {
    checkId, userId: user.id, actorRole: user.role,
    reason: str(formData, 'reason'), now: new Date(),
  }))
}

export async function cancelAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') {
    return { ok: false, message: 'Only a Finance Admin can cancel a check.' }
  }
  const checkId = str(formData, 'checkId')
  return run(checkId, () => cancelCheck(prisma, {
    checkId, userId: user.id,
    reason: str(formData, 'reason'), now: new Date(),
  }))
}
