import type { AvailabilityRequest, Check, Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { loadSettings } from '@/lib/settings/read'
import { loadApprover, canDecide, type Approver } from '@/lib/approvals/approver'
import { DomainError } from './errors'
import {
  markReadyForRelease, revertAvailability, REVERTABLE_STATUSES, type ActionSource, type ApprovalRef,
} from './actions'
import { assertReleasable, assertTransition, checkReadyForRelease, type CheckStatus } from './check-status'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * AVAILABILITY CHANGES ARE APPROVED BY ONE PERSON (spec
 * 2026-11-05-availability-approval-design.md; user ruling the same day: "all
 * should be approved by Paolo Parcon … I want to have control in this because
 * these are also communicated in the supplier").
 *
 * Two changes are told to the supplier: making a check available (SIGNED →
 * READY_FOR_RELEASE) and taking it back (READY_FOR_RELEASE / SCHEDULED →
 * SIGNED). When `approval.availabilityApprover` names a person and the actor
 * is somebody else, the change becomes an `AvailabilityRequest` instead of a
 * write to the check: the check does not move, the portal hears nothing, and
 * the approver applies or rejects it. The approver's own actions, and every
 * action while nobody is set, apply at once through the domain exactly as
 * before — `applyOrRequest` is the one place that decides which.
 *
 * Like `actions.ts`, this module takes `db`: a request is a row and an audit
 * row in one transaction, and approval is the domain action itself plus the
 * request's decision in one transaction.
 */

export type AvailabilityKind = 'MAKE_AVAILABLE' | 'WITHDRAW'

/** The `pendingKey` of an open request; null once decided (one pending per check, see the schema). */
export const PENDING_KEY = 'PENDING'

export const REQUESTED_ACTION = 'availability_requested'
export const APPROVED_ACTION = 'availability_approved'
export const REJECTED_ACTION = 'availability_rejected'

export type RequestArgs = {
  kind: AvailabilityKind
  checkId: string
  requesterId: string
  now: Date
  /** MAKE_AVAILABLE: required by the same guard that applies it. */
  availablePickupDate?: Date | null
  /** WITHDRAW: required, as REVERT TO SIGNED requires it. */
  reason?: string
  /** The uploaded list the request came from, when it did. */
  source?: ActionSource
}

export type GateArgs = Omit<RequestArgs, 'requesterId'> & {
  actor: { id: string }
  /** The approver in force (`loadApprover`), or null: nobody, no approval step. */
  approver: Approver | null
}

export type GateOutcome =
  | { applied: true; check: Check }
  | { applied: false; request: AvailabilityRequest }

/** Status names as the screens say them. */
export function describeKind(kind: AvailabilityKind): string {
  return kind === 'MAKE_AVAILABLE' ? 'READY FOR RELEASE' : 'REVERT TO SIGNED'
}

async function loadCheck(tx: Prisma.TransactionClient, checkId: string) {
  const check = await tx.check.findUnique({ where: { id: checkId }, include: { cashAccount: true, checkBook: true } })
  if (!check) throw new DomainError('NOT_FOUND', 'Check not found.')
  return check
}

/**
 * The refusals a request runs BEFORE it is recorded — the same ones applying
 * would run, so a requester hears "AMOUNT is missing" now and not from the
 * approver days later. Throws a DomainError; returns nothing.
 */
function assertRequestable(
  check: Awaited<ReturnType<typeof loadCheck>>, args: Pick<RequestArgs, 'kind' | 'availablePickupDate' | 'reason'>,
): void {
  assertReleasable({ isCheque: check.isCheque })
  if (args.kind === 'MAKE_AVAILABLE') {
    const guard = checkReadyForRelease({
      status: check.status as CheckStatus,
      checkNumber: check.checkNumber,
      payeeName: check.payeeName,
      amount: check.amount?.toString() ?? null,
      checkDate: check.checkDate,
      cashAccountCode: check.checkBook?.code ?? check.cashAccount?.code ?? null,
      availablePickupDate: args.availablePickupDate ?? null,
      isCheque: check.isCheque,
    })
    if (!guard.ok) throw new DomainError(guard.code, guard.message)
    assertTransition(check.status as CheckStatus, 'READY_FOR_RELEASE')
    return
  }
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to revert availability.')
  }
  if (!REVERTABLE_STATUSES.includes(check.status as CheckStatus)) {
    throw new DomainError('NOT_AVAILABLE', `This check is ${check.status}, not READY FOR RELEASE, so there is no availability to revert.`)
  }
  assertTransition(check.status as CheckStatus, 'SIGNED')
}

async function assertNoPendingRequest(tx: Prisma.TransactionClient, checkId: string): Promise<void> {
  const open = await tx.availabilityRequest.findFirst({
    where: { checkId, status: 'PENDING' }, include: { requestedBy: { select: { name: true } } },
  })
  if (open) {
    throw new DomainError('APPROVAL_PENDING',
      `A ${describeKind(open.kind)} request by ${open.requestedBy.name} is already waiting for approval on this check. Decide it on APPROVALS.`)
  }
}

/**
 * Records a request. The check is untouched. One pending request per check:
 * a second is refused by name, and the unique `(checkId, pendingKey)` index
 * refuses the race the read-then-write leaves open.
 */
export async function requestAvailabilityChange(db: Db, args: RequestArgs): Promise<AvailabilityRequest> {
  const run = async (tx: Prisma.TransactionClient) => {
    const check = await loadCheck(tx, args.checkId)
    assertRequestable(check, args)
    await assertNoPendingRequest(tx, check.id)
    const reason = args.kind === 'WITHDRAW' ? args.reason!.trim() : null
    const pickup = args.kind === 'MAKE_AVAILABLE' ? args.availablePickupDate ?? null : null
    let request: AvailabilityRequest
    try {
      request = await tx.availabilityRequest.create({
        data: {
          checkId: check.id, kind: args.kind, status: 'PENDING', pendingKey: PENDING_KEY,
          requestedById: args.requesterId, requestedAt: args.now,
          availablePickupDate: pickup, reason,
          source: args.source ? (args.source as unknown as Prisma.InputJsonValue) : undefined,
        },
      })
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new DomainError('APPROVAL_PENDING', 'A request is already waiting for approval on this check.')
      }
      throw e
    }
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.requesterId, action: REQUESTED_ACTION,
      details: {
        requestId: request.id, kind: args.kind,
        availablePickupDate: pickup?.toISOString() ?? null, reason,
        ...(args.source ? { source: args.source } : {}),
      },
      remarks: args.kind === 'MAKE_AVAILABLE'
        ? `Requested READY FOR RELEASE, pickup ${pickup?.toISOString().slice(0, 10) ?? 'unset'}.`
        : `Requested REVERT TO SIGNED: ${reason}`,
    })
    return request
  }
  return '$transaction' in db && typeof db.$transaction === 'function'
    ? (db as PrismaClient).$transaction(run)
    : run(db as Prisma.TransactionClient)
}

/**
 * THE GATE. Nobody set, or the actor IS the approver → the domain action, as
 * before this spec. Anybody else → a request. The caller reports which.
 */
export async function applyOrRequest(db: Db, args: GateArgs): Promise<GateOutcome> {
  const direct = args.approver === null || args.approver.id === args.actor.id
  if (direct) {
    const run = async (tx: Prisma.TransactionClient) => {
      // A check with a request waiting is decided on APPROVALS, not acted on
      // past it: applying here would leave the request standing on a check
      // that has moved, and the requester told nothing.
      await assertNoPendingRequest(tx, args.checkId)
      return args.kind === 'MAKE_AVAILABLE'
        ? markReadyForRelease(tx, {
          checkId: args.checkId, userId: args.actor.id, availablePickupDate: args.availablePickupDate ?? null,
          now: args.now, source: args.source,
        })
        : revertAvailability(tx, { checkId: args.checkId, userId: args.actor.id, reason: args.reason ?? '', now: args.now })
    }
    const check = '$transaction' in db && typeof db.$transaction === 'function'
      ? await (db as PrismaClient).$transaction(run)
      : await run(db as Prisma.TransactionClient)
    return { applied: true, check }
  }
  const request = await requestAvailabilityChange(db, { ...args, requesterId: args.actor.id })
  return { applied: false, request }
}

export type Decider = { id: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' }

async function loadPending(tx: Prisma.TransactionClient, requestId: string) {
  const request = await tx.availabilityRequest.findUnique({
    where: { id: requestId }, include: { check: { select: { id: true, status: true, checkNumber: true } } },
  })
  if (!request) throw new DomainError('NOT_FOUND', 'That request does not exist.')
  if (request.status !== 'PENDING') {
    throw new DomainError('REQUEST_DECIDED', `This request was already ${request.status}.`)
  }
  return request
}

/**
 * Who may decide, judged inside the transaction against the setting as it is
 * NOW — the server action checks too, but it is an HTTP endpoint. The approver
 * in force decides; when nobody is set, a Finance Admin may close what is left.
 */
async function assertDecider(tx: Prisma.TransactionClient, actor: Decider): Promise<void> {
  const { approver } = await loadApprover(tx, await loadSettings(tx))
  if (!canDecide(actor, approver)) {
    throw new DomainError('NOT_APPROVER',
      approver ? `Only ${approver.name} can approve or reject availability changes.` : 'Only a Finance Admin can decide this request while no approver is set.')
  }
}

const decisionData = (actor: Decider, now: Date, note: string | null) => ({
  pendingKey: null, decidedById: actor.id, decidedAt: now, decisionNote: note,
})

/**
 * APPROVE: the domain action, applied AS THE APPROVER (`readyById`, the audit
 * actor — that is who caused the message to the supplier), with the request on
 * the audit row's details; then the request is closed APPROVED. A check that
 * moved since the request is refused with its current status (REQUEST_STALE)
 * and nothing is written — the approver rejects it with that as the note.
 */
export async function approveAvailabilityRequest(
  db: PrismaClient, args: { requestId: string; actor: Decider; now: Date; note?: string },
): Promise<{ request: AvailabilityRequest; check: Check }> {
  return db.$transaction(async (tx) => {
    const request = await loadPending(tx, args.requestId)
    await assertDecider(tx, args.actor)
    const from = request.check.status as CheckStatus
    const expected: readonly CheckStatus[] = request.kind === 'MAKE_AVAILABLE' ? ['SIGNED'] : REVERTABLE_STATUSES
    if (!expected.includes(from)) {
      throw new DomainError('REQUEST_STALE',
        `Check ${request.check.checkNumber ?? request.check.id} is now ${from}, so this ${describeKind(request.kind)} request cannot be applied. Reject it, with that as the note.`)
    }
    const approval: ApprovalRef = { requestId: request.id, requestedById: request.requestedById, requestedAt: request.requestedAt }
    const check = request.kind === 'MAKE_AVAILABLE'
      ? await markReadyForRelease(tx, {
        checkId: request.checkId, userId: args.actor.id, availablePickupDate: request.availablePickupDate,
        now: args.now, source: (request.source as ActionSource | null) ?? undefined, approval,
      })
      : await revertAvailability(tx, {
        checkId: request.checkId, userId: args.actor.id, reason: request.reason ?? '', now: args.now, approval,
      })
    const note = args.note?.trim() || null
    const decided = await tx.availabilityRequest.update({
      where: { id: request.id }, data: { status: 'APPROVED', ...decisionData(args.actor, args.now, note) },
    })
    await writeAudit(tx, {
      checkId: request.checkId, actorType: 'USER', userId: args.actor.id, action: APPROVED_ACTION,
      details: { requestId: request.id, kind: request.kind, requestedById: request.requestedById, requestedAt: request.requestedAt.toISOString() },
      ...(note ? { remarks: note } : {}),
    })
    return { request: decided, check }
  })
}

/** REJECT: a note is required; the check is untouched. */
export async function rejectAvailabilityRequest(
  db: PrismaClient, args: { requestId: string; actor: Decider; now: Date; note: string },
): Promise<AvailabilityRequest> {
  const note = args.note?.trim() ?? ''
  if (note === '') throw new DomainError('NOTE_REQUIRED', 'Say why the request is rejected.')
  return db.$transaction(async (tx) => {
    const request = await loadPending(tx, args.requestId)
    await assertDecider(tx, args.actor)
    const decided = await tx.availabilityRequest.update({
      where: { id: request.id }, data: { status: 'REJECTED', ...decisionData(args.actor, args.now, note) },
    })
    await writeAudit(tx, {
      checkId: request.checkId, actorType: 'USER', userId: args.actor.id, action: REJECTED_ACTION,
      details: { requestId: request.id, kind: request.kind, requestedById: request.requestedById, requestedAt: request.requestedAt.toISOString() },
      remarks: note,
    })
    return decided
  })
}
